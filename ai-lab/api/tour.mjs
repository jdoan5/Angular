// Vercel serverless function: /api/tour (Screenshot Tour)
//   GET  /api/tour                      → { apps } the strip, no model call
//   GET  /api/tour?app=<id>&key=<key>   → { tour, receipt, source } ready tour,
//                                         404 { needsLive }, 409 { error:'stale' }
//   POST /api/tour { appId, fresh? }    → NDJSON stream of one tour
// Neither GET ever calls Gemini or needs a key; only POST can, and only when
// no reviewed or cached tour exists or the visitor asked for a fresh one.

import { generateTour, listTourApps, lookupTour, tourApp, isHidden, LIVE_CEILING_MSG } from '../agent-core/tours.mjs';
import { rateLimited, isRateLimit, RATE_LIMIT_MSG } from '../agent-core/ratelimit.mjs';
import { hasCredentials } from '../agent-core/client.mjs';

const NOT_IN_TOUR = { error: 'not in the tour' };
// The strip changes when John ships a release; ten minutes at the edge keeps
// iTunes out of most visitors' path, and a stale copy beats an error page.
const STRIP_CACHE = 'public, s-maxage=600, stale-while-revalidate=3600';
// A ready tour is immutable for its key: a release makes a new key and URL.
const TOUR_CACHE = 'public, s-maxage=86400';

/** Same guard as api/agent.mjs (kept inline: each file here is its own
 *  function bundle). A no-cors form POST from any page used to reach Gemini
 *  on John's key; JSON forces a preflight, and Sec-Fetch-Site catches what's
 *  left. Absent is allowed — curl and servers don't send it. */
function rejectForeign(req, res) {
  const type = String(req.headers?.['content-type'] ?? '').trim().toLowerCase();
  if (!type.startsWith('application/json')) {
    res.status(415).json({ error: 'JSON only' });
    return true;
  }
  const site = req.headers?.['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') {
    res.status(403).json({ error: 'cross-site request' });
    return true;
  }
  return false;
}

/** The text an in-stream 'error' event may carry. Only messages written for
 *  visitors pass; every other error stays generic so internals never reach
 *  the page. */
export function visitorError(err) {
  if (err?.code === 'LIVE_CEILING') return LIVE_CEILING_MSG;
  if (isRateLimit(err)) return RATE_LIMIT_MSG;
  if (err?.code === 'BAD_TOUR') return 'The tour came back ungrounded — try again.';
  return 'The live tour failed — try again in a moment.';
}

function send(res, status, body, cache = 'no-store') {
  res.setHeader('cache-control', cache);
  res.status(status).json(body);
}

async function handleGet(req, res) {
  // new URL, not req.query: dev-server.mjs and server.mjs have no req.query,
  // and all three servers must answer the same.
  const url = new URL(req.url ?? '/', 'http://x');
  const raw = url.searchParams.get('app');
  if (raw === null) {
    send(res, 200, { apps: await listTourApps() }, STRIP_CACHE);
    return;
  }
  const appId = /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(appId)) {
    send(res, 400, { error: 'app must be a numeric App Store id' });
    return;
  }
  if (isHidden(appId)) {
    send(res, 400, NOT_IN_TOUR);
    return;
  }
  const found = await lookupTour(appId, url.searchParams.get('key'));
  switch (found.state) {
    case 'hit':
      send(res, 200, { tour: found.tour, receipt: found.receipt, source: found.source }, TOUR_CACHE);
      return;
    case 'stale':
      send(res, 409, { error: 'stale', tourKey: found.tourKey });
      return;
    case 'miss':
      send(res, 404, { needsLive: true });
      return;
    default:
      send(res, 400, NOT_IN_TOUR);
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      await handleGet(req, res);
    } catch (err) {
      console.warn('tour GET failed:', err);
      send(res, 502, { error: 'The App Store catalog is unavailable right now — try again shortly.' });
    }
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'GET or POST only' });
    return;
  }
  // Stop fetching and spending model quota the moment the visitor leaves.
  // Wired before the first await: a visitor who left while a cold catalog
  // loaded from iTunes fired 'close' before a later listener existed, and a
  // review probe watched that tour fetch all four screenshots for nobody.
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const gone = () => ac.signal.aborted || res.destroyed === true || req.socket?.destroyed === true;

  // Before the limiter too, so a hostile page can't burn a visitor's quota.
  if (rejectForeign(req, res)) return;
  try {
    if (rateLimited(req)) {
      res.status(429).json({ error: 'Too many requests — try again in a minute.' });
      return;
    }
    const { appId, fresh } = req.body ?? {};
    // A number, not a numeric string: '6801322941abc' and '__proto__' stop here.
    if (!Number.isSafeInteger(appId)) {
      res.status(400).json({ error: 'appId must be an integer App Store id' });
      return;
    }
    // Hidden is a constant, so it is answered before the credential gate: no
    // network either way, and a keyless deploy still says "not in the tour".
    if (isHidden(appId)) {
      res.status(400).json(NOT_IN_TOUR);
      return;
    }
    // Before any network, so a keyless deploy (and the test suite) stops here.
    if (!hasCredentials()) {
      res.status(503).json({ error: 'Tour not configured: credentials are missing.' });
      return;
    }
    const app = await tourApp(appId);
    // Gone during the catalog load: nobody to answer, nothing to start.
    if (gone()) {
      ac.abort();
      return;
    }
    if (!app) {
      res.status(400).json(NOT_IN_TOUR);
      return;
    }

    // NDJSON, one event per line (tool-start, tool-end, tour, done, error).
    // Errors after this point arrive in-band, since the headers are gone.
    res.status(200);
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    const emit = (event) => res.write(JSON.stringify(event) + '\n');

    try {
      await generateTour({ appId, fresh: fresh === true }, ac.signal, emit);
    } catch (err) {
      if (!ac.signal.aborted) {
        console.warn('tour stream failed:', err);
        emit({ type: 'error', error: visitorError(err) });
      }
    }
    res.end();
  } catch (err) {
    console.warn('tour request failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Tour request failed.' });
    else res.end();
  }
}
