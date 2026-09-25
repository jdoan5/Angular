// Screenshot Tour: multimodal image understanding with grounded pins. One
// generateContent call gets up to four of an app's real App Store iPhone
// screenshots plus its store description, and returns callouts (a box on one
// screenshot, a label, and a quote from the description). Every callout is
// checked here before a visitor sees it: the box must be on the screen and
// the quote must really be in the listing, so a pin can never point at a
// feature the store copy does not claim. Server-side only, like the rest of
// the agent core.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FinishReason, ThinkingLevel, PartMediaResolutionLevel, createPartFromBase64 } from '@google/genai';
import { makeGenAI } from './client.mjs';
import { catalogApps } from './tools.mjs';

export const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

// Store order, first four: the order visitors see on the App Store (Toehold
// lists 05-gentle before 04-tough, so sorting by filename would reorder it).
export const MAX_SHOTS = 4;
// Fewer than three leaves too little to ground a tour against; every visible
// app had 3-5 on 2026-09-25.
export const MIN_SHOTS = 3;
export const MAX_CALLOUTS = 12;   // 3 per screenshot at most, 4 screenshots
const SHOT_SIZE = '600x1300bb.jpg';
// 600x1300 came back as 598x1300 JPEGs of 40-190 KB on 2026-09-25, so the cap
// is roomy for a real screenshot and still bounds what one tour holds in memory.
export const MAX_SHOT_BYTES = 400 * 1024;
const FETCH_TIMEOUT_MS = 8000;
// Apple caps a description at 4,000 characters; John's run 1.2-3.5K.
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_LABEL_CHARS = 40;
const MIN_QUOTE_WORDS = 4;
// Boxes are on Gemini's 0-1000 grid. A side under 15 is a sliver no pin can
// sit on, and ymax under 60 is the status bar (clock, signal, battery).
const MIN_BOX_SIDE = 15;
const STATUS_BAR_YMAX = 60;
// One corrective retry, as in missions.mjs: a second failure is a bad tour.
const MAX_ATTEMPTS = 2;
// The spike call (4 screenshots at HIGH) stopped in 7.8 s with a 5,257-token
// prompt; 4096 is the same output headroom as every other stage.
const MAX_OUTPUT_TOKENS = 4096;
const MEDIA_RESOLUTION = PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH;

// Live tours per instance per hour, on top of the 8/min per-IP limiter: each
// one is up to two ~5K-token image calls on John's key, and the pre-reviewed
// snapshot already answers every visitor who does not press "Watch it live".
export const LIVE_TOURS_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;
export const LIVE_CEILING_MSG =
  'Live tours have used up this hour\'s share of the free quota — try again later.';
// Instance cache of live tours, keyed by tourKey.
const MAX_CACHED_TOURS = 32;

/** Apps left out of the tour entirely: not in the strip, and 400 'not in the
 *  tour' for any GET or POST that names them. Streak Rings: its store
 *  screenshots show an iPhone UI while its description says it is made only
 *  for Apple Watch, so every pin would ground a watch-only claim on an iPhone
 *  screen. Hidden until the listing is fixed. */
export const HIDDEN_APPS = Object.freeze({
  6784836738: 'Streak Rings: iPhone screenshots on a watch-only listing',
});
export const isHidden = (appId) => Object.hasOwn(HIDDEN_APPS, String(appId));

// ---------------------------------------------------------------- screenshot URLs

// The whole URL, not a parsed host: new URL() quietly resolves "/../" and
// decodes nothing, so a check on its pieces can pass a URL whose raw text says
// something else. Segments start with a letter or digit (so "." and ".." can't
// be one) and allow no "%", "@", ":", "?", "#" or "\": no encoded traversal,
// userinfo, port, query or fragment. The last segment is Apple's size.
const SHOT_URL =
  /^https:\/\/is1-ssl\.mzstatic\.com\/image\/thumb\/((?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/){2,12})\d{2,4}x\d{2,4}bb\.(?:jpg|png)$/;

/** The screenshot at the tour's size (600x1300 JPEG), or throws when `raw`
 *  is not an App Store screenshot URL. Every URL the server fetches goes
 *  through this, so the fetcher can never be pointed anywhere else. */
export function assertShotUrl(raw) {
  const m = typeof raw === 'string' && raw.length <= 1024 ? SHOT_URL.exec(raw) : null;
  if (!m) throw new Error('not an App Store screenshot URL');
  return `https://is1-ssl.mzstatic.com/image/thumb/${m[1]}${SHOT_SIZE}`;
}

/** The first MAX_SHOTS iPhone screenshots in store order, rewritten to the
 *  tour size. A URL that fails the guard is skipped, not fatal: one odd URL
 *  from iTunes should cost one screenshot, not the app's whole tour. */
export function selectShots(app) {
  const urls = Array.isArray(app?.screenshotUrls) ? app.screenshotUrls : [];
  const shots = [];
  for (const raw of urls) {
    if (shots.length === MAX_SHOTS) break;
    let url;
    try { url = assertShotUrl(raw); } catch { continue; }
    if (!shots.includes(url)) shots.push(url);
  }
  return shots;
}

/** Identity of one tour: app, version and the exact screenshots. A new
 *  release or a reordered screenshot makes a new key, which retires every
 *  snapshot and cached tour drawn on the old ones. */
export function tourKey(appId, version, shots) {
  const hash = createHash('sha256').update(shots.join('\n')).digest('hex').slice(0, 12);
  return `${appId}:${version}:${hash}`;
}

// ---------------------------------------------------------------- fetching

let fetcher = (...args) => fetch(...args);
let loadCatalog = catalogApps;

/** Test hooks: swap the screenshot fetcher or the catalog source (null
 *  restores the real one). */
export function _setFetcherForTests(fn) { fetcher = fn ?? ((...args) => fetch(...args)); }
export function _setCatalogForTests(fn) { loadCatalog = fn ?? catalogApps; }

/** Fetch one screenshot as bytes. The URL is re-checked here (the fetcher
 *  must never be handed anything else), redirects are refused so the guard
 *  can't be stepped around, and the size cap counts the bytes actually read:
 *  a missing or lying content-length can't stream past it. */
export async function fetchShot(url, signal) {
  const safe = assertShotUrl(url);
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetcher(safe, {
      redirect: 'error',
      headers: { accept: 'image/jpeg' },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!res.ok) throw new Error(`screenshot fetch failed: HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') ?? '').toLowerCase();
    if (!type.startsWith('image/jpeg')) throw new Error(`screenshot is ${type || 'untyped'}, not image/jpeg`);
    if (Number(res.headers.get('content-length')) > MAX_SHOT_BYTES) throw new Error('screenshot is over the size cap');
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SHOT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('screenshot is over the size cap');
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    // A JPEG starts FF D8 FF whatever its header claims.
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error('screenshot body is not a JPEG');
    }
    return bytes;
  } catch (err) {
    await res?.body?.cancel?.().catch(() => {});
    if (err?.name === 'TimeoutError') throw new Error(`screenshot fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw err;
  }
}

//__APPEND_HERE__
