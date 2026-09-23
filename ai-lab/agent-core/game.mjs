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
      // Where this round starts in the browser's history, set by api/agent.mjs
      // when it deals. Dropping it here handed question 2 onward the whole
      // history again, old reveal included.
      ...(Number.isInteger(state.historyStart) && state.historyStart >= 0
        ? { historyStart: state.historyStart }
        : {}),
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

/** Other names an app answers to, by trackId: names its own live store copy
 *  still uses, so the host reads them in the fact sheet and players say them.
 *  Every alias is accepted as a correct guess.
 *
 *  `redact` marks proper nouns — retired names that ARE the app ("Invoice
 *  Tracker is a simple, private ledger…") and must be scrubbed like its title.
 *  Genre names ("Tic Tac Toe", "Habit Tracker") are left in: they describe
 *  what the app is, and scrubbing them would gut the clue. A player who names
 *  the app the way its own store page does has earned the win. */
export const ALIASES = {
  6782749406: [{ name: 'Invoice Tracker', redact: true }],
  6778971932: [{ name: 'Civics Test 2025', redact: true }, { name: 'Civics Test', redact: true }],
  // "503020" is written "50/30/20" in its own copy; the title redaction
  // already covers it, the alias makes the guess count.
  6780275076: [{ name: '50/30/20', redact: true }],
  6784836738: [{ name: 'Habit Tracker', redact: false }],
  6772803398: [
    { name: 'Tic Tac Toe', redact: false },
    { name: 'Tictactoe', redact: false },
    { name: '3 in a row', redact: false },
  ],
};

const redactedAliases = (appId) =>
  (ALIASES[appId] ?? []).filter((a) => a.redact).map((a) => a.name);

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
 *  a redacted clue is a worse puzzle, but a leaked name is no puzzle at all.
 *  Pass appId to also strip the app's proper-noun aliases — whole phrases
 *  only, since "invoice" and "test" alone are ordinary vocabulary. */
export function redactName(text, name, appId) {
  let out = String(text ?? '');
  // One longest-first pass over both lists, so no shorter variant can split a
  // longer one before it is consumed.
  const variants = [...new Set([...nameVariants(name), ...redactedAliases(appId)])]
    .sort((a, b) => b.length - a.length);
  for (const variant of variants) {
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

// Every question rebuilds the fact sheet, and Apple throttles the lookup API
// at roughly 20 calls a minute, so an app's details live as long as the
// catalog does. Only successes are kept; a failure retries next time.
const detailsCache = new Map();

async function appDetails(appId) {
  const hit = detailsCache.get(appId);
  if (hit && Date.now() - hit.at < APPS_TTL_MS) return hit.details;
  const details = await getAppDetails({ appId });
  if (details?.error) throw new Error(details.error);
  detailsCache.set(appId, { at: Date.now(), details });
  return details;
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
    `what it does (name removed): ${redactName(details.description, details.name, details.appId).slice(0, DESCRIPTION_CHARS)}`,
  ].join('\n');
}

// ------------------------------------------------------------------ lifecycle

/** Pick a random app and build the turn context for a brand-new game.
 *  excludeAppId is never dealt unless it is the only app there is. */
export async function startGame(excludeAppId) {
  const apps = await catalog();
  if (!apps.length) throw new Error('No apps available to play with.');
  const others = apps.filter((a) => a.appId !== excludeAppId);
  const pool = others.length ? others : apps;
  const pick = pool[randomInt(pool.length)];
  const details = await appDetails(pick.appId);
  return {
    state: { appId: pick.appId, name: details.name, url: details.url ?? pick.url ?? '', asked: 0, over: false },
    facts: factSheet(details),
    fresh: true,
  };
}

/** Rebuild the fact sheet for a game already in progress. */
export async function resumeGame(state) {
  return { state, facts: factSheet(await appDetails(state.appId)), fresh: false };
}

/** Resume the sealed game if there is one, otherwise deal a new app. */
export async function loadGame(token) {
  const existing = unseal(token);
  if (existing && !existing.over) {
    try {
      return await resumeGame(existing);
    } catch {
      /* app pulled from the store mid-game — fall through to a new one. With
         details cached, that is noticed only once its cache entry expires,
         up to APPS_TTL_MS after the pull. */
    }
  }
  // Never re-deal the app just revealed (1 draw in 15 did): its name is still
  // on screen and may still be in the history the model reads.
  return startGame(existing?.appId);
}

// ------------------------------------------------------------- guess matching

//
// A guess is judged against the whole catalog, not just the secret. Matching
// the secret alone could only ask "does this look like the answer?", which
// rejected "Snake" and "Job Trail" (no colon, so only the full title counted)
// while a prefix test accepted "Toeholds are fun" and "Cosmic Cadets or Streak
// Rings". Asking "which app does this name?" gets both right.

/** Lower-case words, punctuation gone, digits kept. "&" reads as "and" so
 *  "Bills & Invoices" is one spelling, and apostrophes vanish rather than
 *  splitting a word in two. */
function words(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['\u2019]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Title words too generic to name an app on their own: "english" is in two
// titles, and "budget", "sudoku" or "soccer" are what players ASK about ("is
// it a sudoku app?"), which must not win the round or spend the guess. They
// still count inside a longer phrase — "Budget Coach", "Sudoku Explained" and
// "Soccer 2026" are names. 2026 is every app's release year.
//
// Known tradeoffs, kept on purpose:
// - "Snake" stays a name: players say it for LCD Classic Snake, so "is it a
//   snake game?" reads as a guess.
// - Runs of generic words still count ("does it show live scores?" names
//   Soccer 2026), because "Job Trail", "Medical Refill" and "Three in a Row"
//   are made of nothing else. Aliases likewise: "is it about the civics
//   test?" names US Citizenship. The host prompt only sends names here; this
//   stoplist is the backstop for single words, not a question detector.
const GENERIC_WORDS = new Set([
  'english', 'learn', 'budget', 'coach', 'classic', 'medical', 'refill', 'family',
  'questions', 'prep', 'applications', 'job', 'live', 'scores', 'drop', 'alerts',
  'home', 'inventory', 'bills', 'invoices', 'explained', 'rings', 'trail', 'price',
  'duel', 'three', 'row', '2026',
  'sudoku', 'soccer', 'citizenship', 'pronunciation', 'streak',
]);

// Glue: a run of title words may not start or end on one, so "Three in a Row
// Duel" yields "three in a row" but never "in a" or "a row".
const GLUE_WORDS = new Set(['a', 'an', 'and', 'the', 'in', 'of', 'for', 'to', 'on', 'or', 'at', 'by', 'with']);

/** Every word sequence that names this app: the full title, each colon
 *  segment, each run of 2+ title words, each distinctive single word, and its
 *  aliases. */
function namePhrases(app) {
  const phrases = [words(app.name)];
  for (const segment of String(app.name).split(':')) {
    const w = words(segment);
    if (w.length > 1) phrases.push(w);
    for (let i = 0; i < w.length; i++) {
      if (GLUE_WORDS.has(w[i])) continue;
      for (let j = i + 1; j < w.length; j++) {
        if (!GLUE_WORDS.has(w[j])) phrases.push(w.slice(i, j + 1));
      }
      if (w[i].length >= 3 && !GENERIC_WORDS.has(w[i])) phrases.push([w[i]]);
    }
  }
  for (const alias of ALIASES[app.appId] ?? []) phrases.push(words(alias.name));
  return phrases.filter((p) => p.length);
}

/** The catalog apps a guess names, as appIds. Pure and synchronous so tests
 *  can drive it with a fixed catalog.
 *
 *  Phrases match whole words ("toeholds" is not "toehold"), longest first.
 *  A guess word belongs to the longest phrase covering it, so a longer name
 *  is never also read as a shorter one inside it; phrases of equal length
 *  tie, so a word two titles share stays ambiguous rather than going to
 *  whichever app happens to be listed first. */
export function matchGuess(guess, apps) {
  const g = words(guess);
  const candidates = (apps ?? [])
    .flatMap((app) => namePhrases(app).map((phrase) => ({ appId: app.appId, phrase })))
    .sort((a, b) => b.phrase.length - a.phrase.length);
  const claimedBy = new Array(g.length).fill(0);   // length of the claiming phrase
  const matched = new Set();
  for (const { appId, phrase } of candidates) {
    const n = phrase.length;
    for (let i = 0; i + n <= g.length; i++) {
      if (phrase.every((w, k) => g[i + k] === w && (claimedBy[i + k] === 0 || claimedBy[i + k] === n))) {
        claimedBy.fill(n, i, i + n);
        matched.add(appId);
      }
    }
  }
  return [...matched];
}

/** The catalog to judge against, always including the secret: if the app was
 *  pulled mid-round, a right guess must still win. Null when the lookup fails.
 *  Judging against the secret alone was the old fallback, and there a guess
 *  listing several apps matched only the secret and won. */
async function guessableApps(state) {
  let apps;
  try {
    apps = await catalog();
  } catch {
    return null;
  }
  return apps.some((a) => a.appId === state.appId)
    ? apps
    : [...apps, { appId: state.appId, name: state.name }];
}

// ------------------------------------------------------------------- tools

/** Check a name the player guessed. The only path that can confirm the answer.
 *
 *  One judged guess per question. The server charges one question per HTTP
 *  turn, so a message listing all fifteen names fanned out into fifteen calls
 *  and won on question 1. The context is built fresh per request, so the
 *  count on it is exactly "this turn". Only a call that is actually judged
 *  against the secret spends it: naming several apps, or none, reveals nothing
 *  and must not burn the player's one real guess. */
export async function checkGuess({ name } = {}, context = {}) {
  const state = context.state;
  if (!state) return { error: 'No game in progress.' };
  if (typeof name !== 'string' || !name.trim()) return { error: 'A guess needs an app name.' };
  const apps = await guessableApps(state);
  // Not judged, so the turn's guess is not spent.
  if (!apps) return { error: "Can't check guesses right now - try again" };
  // After the await, so the check and the count below run in one synchronous
  // step: even calls executed in parallel cannot both get through.
  if (context.guesses > 0) {
    return { error: 'One guess per question - ask the player which single app they mean' };
  }
  const named = matchGuess(name, apps);
  if (named.length > 1) return { error: 'Name one app at a time' };

  const tally = { questionsUsed: state.asked, questionsLeft: Math.max(0, QUESTION_LIMIT - state.asked) };
  if (named.length === 0) {
    return {
      correct: false, guessed: name.trim(), recognized: false,
      // Also where a category question lands ("is it a sudoku app?") if the
      // host mistakes it for a guess, so point it back at the fact sheet
      // rather than let it tell the player no such app exists.
      note: "That is not the name of one of John's apps, so it was not counted as a guess. If the player was asking about a feature or category, answer that from the fact sheet instead.",
      ...tally,
    };
  }
  context.guesses = (context.guesses ?? 0) + 1;
  if (named[0] === state.appId) {
    state.over = true;
    return { correct: true, appName: state.name, appUrl: state.url, questionsUsed: state.asked };
  }
  return { correct: false, guessed: name.trim(), ...tally };
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
      'Check whether the player has guessed the secret app correctly. Call this the moment the player names an app, passing just that app name. Only one guess can be checked per question. Returns correct:true with the real name when they get it, or correct:false when they do not.',
    parameters: {
      type: 'OBJECT',
      properties: { name: { type: 'STRING', description: 'Just the app name the player guessed, without the rest of their message' } },
      required: ['name'],
    },
  },
  give_up: {
    fn: giveUp,
    description:
      'Reveal the secret app. Call this only when the player gives up, asks to be told, or has used all their questions.',
  },
};
