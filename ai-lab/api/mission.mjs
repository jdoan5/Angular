// Vercel serverless function: POST /api/mission
// Body: { skill: keyof SKILLS, tier: 1-5 }
// Returns { mission, model } — schema-validated JSON from Gemini.

import { generateMission, SKILLS } from '../agent-core/missions.mjs';
import { rateLimited, isRateLimit, RATE_LIMIT_MSG } from '../agent-core/ratelimit.mjs';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  // Before the limiter too, so a hostile page can't burn a visitor's quota.
  if (rejectForeign(req, res)) return;
  try {
    if (rateLimited(req)) {
      res.status(429).json({ error: 'Too many requests — try again in a minute.' });
      return;
    }
    const { skill, tier } = req.body ?? {};
    if (!(typeof skill === 'string' && Object.hasOwn(SKILLS, skill))) {
      res.status(400).json({ error: 'unknown skill' });
      return;
    }
    if (!Number.isInteger(tier) || tier < 1 || tier > 5) {
      res.status(400).json({ error: 'tier must be an integer 1-5' });
      return;
    }

    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });

    const result = await generateMission({ skill, tier }, ac.signal);
    res.status(200).json(result);
  } catch (err) {
    if (err?.code === 'NO_KEY') {
      res.status(503).json({ error: 'Agent not configured: GEMINI_API_KEY is missing.' });
      return;
    }
    if (err?.code === 'BAD_REQUEST') {
      // Unreachable while the checks above run first — this is the safety net
      // for a future call path that skips them.
      res.status(400).json({ error: 'unknown skill or tier' });
      return;
    }
    if (err?.code === 'BAD_MISSION') {
      res.status(502).json({ error: 'The mission came back scrambled — try again.' });
      return;
    }
    if (isRateLimit(err)) {
      res.status(429).json({ error: RATE_LIMIT_MSG });
      return;
    }
    console.error('mission request failed:', err);
    res.status(500).json({ error: 'Mission generation failed.' });
  }
}
