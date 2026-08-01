// Best-effort per-instance rate limit (in-memory, resets on cold start).
// Real abuse protection for a public deploy is a Vercel WAF rate-limit rule;
// this guards against naive scripted hammering at zero cost. Shared by every
// /api function.

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 8;
const hits = new Map();

/** True when an upstream Gemini error is a free-tier quota blip, so the UI can
 *  say "wait a minute" instead of looking broken. */
export function isRateLimit(err) {
  return err?.status === 429 || /RESOURCE_EXHAUSTED|429/.test(String(err?.message ?? ''));
}
export const RATE_LIMIT_MSG =
  'The free-tier quota needs a breather — wait about a minute, then try again.';

/** True if this request should be rejected with 429. */
export function rateLimited(req) {
  const ip =
    (req.headers['x-forwarded-for']?.split(',')[0] ?? '').trim() ||
    req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  if (hits.size > 1000) hits.clear();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_PER_WINDOW;
}
