// Vercel serverless function: POST /api/mission
// Body: { skill: keyof SKILLS, tier: 1-5 }
// Returns { mission, model } — schema-validated JSON from Gemini.

import { generateMission, SKILLS } from '../agent-core/missions.mjs';
import { rateLimited, isRateLimit, RATE_LIMIT_MSG } from '../agent-core/ratelimit.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
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
