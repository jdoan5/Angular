// Guess My App: twenty questions against the live App Store catalog.
//
// The whole design problem is keeping one fact secret from a stateless server
// whose entire conversation lives in the browser. Three rules make it work:
//
//   1. The model never learns the answer. It is handed a name-redacted fact
//      sheet and nothing else, so it cannot leak what it does not have.
//   2. The secret rides in a sealed token (AES-256-GCM). The browser stores an
//      opaque blob and echoes it back each turn; only the server can open it.
//      No session store, so this survives serverless cold starts.
//   3. Only check_guess and give_up can reveal the name, and both run
//      server-side against the unsealed state.
//
// Set GAME_SECRET in the deploy environment so tokens stay valid across
// instances; without it each process derives its own key and a game that
// lands on a different instance simply restarts (handled, not fatal).

import { createCipheriv, createDecipheriv, randomBytes, randomInt, hkdfSync } from 'node:crypto';
import { listMyApps, getAppDetails } from './tools.mjs';

export const QUESTION_LIMIT = 20;

const APPS_TTL_MS = 5 * 60_000;
const MAX_TOKEN_BYTES = 4096;
const IV_LEN = 12;
const TAG_LEN = 16;
const DESCRIPTION_CHARS = 700;
const REDACTED = '[the app name]';

// ---------------------------------------------------------------- key + seal

const processKey = randomBytes(32);
let derived = null;

function key() {
  const secret = process.env.GAME_SECRET;
  if (!secret) return processKey;
  if (!derived) {
    derived = Buffer.from(
      hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from('ai-lab guess-my-app v1'), 32)
    );
  }
  return derived;
}

/** Seal game state into an opaque token the browser can hold but not read. */
export function seal(state) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** Open a token. Returns null for anything tampered with, stale or malformed —
 *  callers treat null as "no game in progress" and start a fresh one. */
export function unseal(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_BYTES) return null;
  try {
    const buf = Buffer.from(token, 'base64url');
    if (buf.length <= IV_LEN + TAG_LEN) return null;
    const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, IV_LEN));
    decipher.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
    const json = Buffer.concat([
      decipher.update(buf.subarray(IV_LEN + TAG_LEN)),
      decipher.final(),
    ]).toString('utf8');
    const state = JSON.parse(json);
    if (!state || typeof state.appId !== 'number' || typeof state.name !== 'string') return null;
    return {
      appId: state.appId,
      name: state.name,
      url: typeof state.url === 'string' ? state.url : '',
      asked: Number.isInteger(state.asked) ? state.asked : 0,
      over: state.over === true,
    };
  } catch {
    return null; // bad tag, wrong key, garbage input — all mean "start over"
  }
}

// ------------------------------------------------------------------ redaction

/** Every spelling of the app's name we refuse to hand the model: the full
 *  title, each colon-separated part, and every word inside them.
 *
 *  Both halves matter. "503020: Budget Coach" opens its own description with
 *  "Budget Coach turns your monthly income…" — redacting only the head would
 *  hand the player the answer in the first sentence. */
export function nameVariants(name) {
  const segments = name.split(':').map((s) => s.trim()).filter(Boolean);
  const words = segments
    .flatMap((s) => s.split(/\s+/))
    .filter((w) => w.replace(/[^A-Za-z0-9]/g, '').length >= 3);
  // Longest first, so "Toehold: Sudoku Explained" is consumed before "Toehold".
  return [...new Set([name, ...segments, ...words])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Match a name however the store copy happens to punctuate it. The title
 *  "503020: Budget Coach" is written "50/30/20" in its own description, so a
 *  literal match sails straight past it — we compare on alphanumerics and
 *  tolerate any short separator between them. */
function loosePattern(variant) {
  const chars = variant.replace(/[^A-Za-z0-9]/g, '').split('');
  if (!chars.length) return null;
  const body = chars.map(escapeRe).join('[^A-Za-z0-9]{0,3}');
  // Lookarounds, not \b: these names start and end with digits as often as letters.
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'gi');
}

/** Strip the app's name out of its own store copy. Deliberately aggressive:
 *  a redacted clue is a worse puzzle, but a leaked name is no puzzle at all. */
export function redactName(text, name) {
  let out = String(text ?? '');
  for (const variant of nameVariants(name)) {
    const re = loosePattern(variant);
    if (re) out = out.replace(re, REDACTED);
  }
  return out;
}

// ------------------------------------------------------------------- catalog

let cache = null;

async function catalog() {
  if (cache && Date.now() - cache.at < APPS_TTL_MS) return cache.apps;
  const { apps } = await listMyApps();
  cache = { at: Date.now(), apps };
  return apps;
}

// ---------------------------------------------------------------- fact sheet

function releasedPhrase(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${d.getUTCFullYear()}`;
}

/** Everything the model is allowed to know: enough to answer yes/no honestly,
 *  with the name scrubbed out of it. */
function factSheet(details) {
  const genres = (details.genre ? [details.genre] : []).concat(
    Array.isArray(details.genres) ? details.genres.filter((g) => g !== details.genre) : []
  );
  const ratings = details.ratingCount
    ? `${details.averageRating ?? '?'} stars from ${details.ratingCount} rating(s)`
    : 'no ratings yet';
  return [
    `category: ${genres.join(', ') || 'unknown'}`,
    `price: ${details.price === 0 || details.formattedPrice === 'Free' ? 'free' : (details.formattedPrice ?? 'unknown')}`,
    `released: ${releasedPhrase(details.released)}`,
    `last updated: ${releasedPhrase(details.lastUpdated)} (version ${details.version ?? '?'})`,
    `requires: iOS ${details.minimumOsVersion ?? '?'} or later`,
    `download size: ${details.sizeMB ?? '?'} MB`,
    `age rating: ${details.contentRating ?? 'unknown'}`,
    `ratings: ${ratings}`,
    `what it does (name removed): ${redactName(details.description, details.name).slice(0, DESCRIPTION_CHARS)}`,
  ].join('\n');
}

// ------------------------------------------------------------------ lifecycle

/** Pick a random app and build the turn context for a brand-new game. */
export async function startGame() {
  const apps = await catalog();
  if (!apps.length) throw new Error('No apps available to play with.');
  const pick = apps[randomInt(apps.length)];
  const details = await getAppDetails({ appId: pick.appId });
  if (details?.error) throw new Error(details.error);
  return {
    state: { appId: pick.appId, name: details.name, url: details.url ?? pick.url ?? '', asked: 0, over: false },
    facts: factSheet(details),
    fresh: true,
  };
}

/** Rebuild the fact sheet for a game already in progress. */
export async function resumeGame(state) {
  const details = await getAppDetails({ appId: state.appId });
  if (details?.error) throw new Error(details.error);
  return { state, facts: factSheet(details), fresh: false };
}

/** Resume the sealed game if there is one, otherwise deal a new app. */
export async function loadGame(token) {
  const existing = unseal(token);
  if (existing && !existing.over) {
    try {
      return await resumeGame(existing);
    } catch {
      /* app pulled from the store mid-game — fall through to a new one */
    }
  }
  return startGame();
}

// ------------------------------------------------------------- guess matching

const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Accept the short name people actually say: "Toehold" for
 *  "Toehold: Sudoku Explained", but never a 2-letter fragment that would
 *  match half the catalog. */
export function guessMatches(guess, name) {
  const g = normalize(guess);
  if (g.length < 3) return false;
  const full = normalize(name);
  const head = normalize(name.split(':')[0]);
  return g === full || g === head || (head.length >= 4 && g.startsWith(head)) ;
}

// ------------------------------------------------------------------- tools

/** Check a name the player guessed. The only path that can confirm the answer. */
export function checkGuess({ name } = {}, context = {}) {
  const state = context.state;
  if (!state) return { error: 'No game in progress.' };
  if (typeof name !== 'string' || !name.trim()) return { error: 'A guess needs an app name.' };
  const correct = guessMatches(name, state.name);
  if (correct) {
    state.over = true;
    return { correct: true, appName: state.name, appUrl: state.url, questionsUsed: state.asked };
  }
  return { correct: false, guessed: name.trim(), questionsUsed: state.asked, questionsLeft: Math.max(0, QUESTION_LIMIT - state.asked) };
}

/** Reveal the answer when the player gives up or runs out of questions. */
export function giveUp(_args, context = {}) {
  const state = context.state;
  if (!state) return { error: 'No game in progress.' };
  state.over = true;
  return { revealed: true, appName: state.name, appUrl: state.url, questionsUsed: state.asked };
}

/** Registry entries merged into the shared tool registry by tools.mjs. */
export const gameTools = {
  check_guess: {
    fn: checkGuess,
    description:
      'Check whether the player has guessed the secret app correctly. Call this the moment the player names any app. Returns correct:true with the real name when they get it, or correct:false when they do not.',
    parameters: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING', description: 'The app name the player guessed, exactly as they wrote it' } },
      required: ['name'],
    },
  },
  give_up: {
    fn: giveUp,
    description:
      'Reveal the secret app. Call this only when the player gives up, asks to be told, or has used all their questions.',
  },
};
