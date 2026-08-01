// Vercel serverless function: POST /api/agent
// Body: { message: string, history?: [{role:'user'|'model', text:string}] }
// The GEMINI_API_KEY env var is configured in Vercel project settings and
// never leaves the server.

import { runAgentStream } from '../agent-core/agent.mjs';
import { AGENTS } from '../agent-core/agents.mjs';
import { listMyApps, getAppReviews } from '../agent-core/tools.mjs';
import { rateLimited } from '../agent-core/ratelimit.mjs';

const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_TURNS = 20;

/** Keep only well-formed turns, capped in count and per-turn length. */
function sanitizeHistory(history) {
  return history
    .filter(
      (t) =>
        t && (t.role === 'user' || t.role === 'model') &&
        typeof t.text === 'string' && t.text.trim()
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({ role: t.role, text: t.text.slice(0, MAX_MESSAGE_CHARS) }));
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Health/status for the UI banner: is the agent configured?
    res.status(200).json({ ok: true, hasKey: Boolean(process.env.GEMINI_API_KEY) });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    if (rateLimited(req)) {
      res.status(429).json({ error: 'Too many requests — try again in a minute.' });
      return;
    }

    const { message, history, selftest, agent } = req.body ?? {};

    if (selftest) {
      // Key-free verification path: exercises the live iTunes tools only.
      const apps = await listMyApps();
      const first = apps.apps[0];
      const reviews = first ? await getAppReviews({ appId: first.appId }) : null;
      res.status(200).json({ ok: true, apps: apps.count, sampleApp: first?.name ?? null, sampleReviews: reviews?.count ?? 0 });
      return;
    }

    if (typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message (string) is required' });
      return;
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      res.status(400).json({ error: `message too long (max ${MAX_MESSAGE_CHARS} chars)` });
      return;
    }
    if (history !== undefined && !Array.isArray(history)) {
      res.status(400).json({ error: 'history must be an array' });
      return;
    }
    if (agent !== undefined && !(typeof agent === 'string' && Object.hasOwn(AGENTS, agent))) {
      res.status(400).json({ error: 'unknown agent' });
      return;
    }
    if (!process.env.GEMINI_API_KEY) {
      res.status(503).json({ error: 'Agent not configured: GEMINI_API_KEY is missing.' });
      return;
    }

    // Stream progress as NDJSON: one JSON event per line (tool-start,
    // tool-end, delta, draft-discard, done, error). Errors after the stream
    // has started are delivered as an in-band event, since headers are gone.
    res.status(200);
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    const emit = (event) => res.write(JSON.stringify(event) + '\n');

    // Stop spending model quota the moment the client disconnects.
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });

    try {
      await runAgentStream(agent, sanitizeHistory(history ?? []), message.trim(), emit, ac.signal);
    } catch (err) {
      if (!ac.signal.aborted) {
        console.error('agent stream failed:', err);
        emit({ type: 'error', error: 'Agent request failed.' });
      }
    }
    res.end();
  } catch (err) {
    if (err?.code === 'NO_KEY') {
      res.status(503).json({ error: 'Agent not configured: GEMINI_API_KEY is missing.' });
      return;
    }
    console.error('agent request failed:', err);
    res.status(500).json({ error: 'Agent request failed.' });
  }
}
