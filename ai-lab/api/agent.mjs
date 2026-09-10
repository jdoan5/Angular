// Vercel serverless function: POST /api/agent
// Body: { message: string, history?: [{role:'user'|'model', text:string}] }
// The GEMINI_API_KEY env var is configured in Vercel project settings and
// never leaves the server.

import { runAgentStream } from '../agent-core/agent.mjs';
import { AGENTS } from '../agent-core/agents.mjs';
import { listMyApps, getAppReviews } from '../agent-core/tools.mjs';
import { rateLimited, isRateLimit, RATE_LIMIT_MSG } from '../agent-core/ratelimit.mjs';
import { hasCredentials, authMode } from '../agent-core/client.mjs';
import { loadGame, seal, QUESTION_LIMIT } from '../agent-core/game.mjs';

const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_TURNS = 20;
const MAX_TOKEN_CHARS = 4096;

/** Build the per-turn context for Guess My App: unseal (or deal) the secret,
 *  hand the model a name-redacted fact sheet, and re-seal the state on the way
 *  out. The secret never enters the chat history the browser holds. */
async function gameContext(gameToken) {
  const { state, facts, fresh } = await loadGame(gameToken);
  state.asked = Math.min(state.asked + 1, QUESTION_LIMIT);
  const remaining = Math.max(0, QUESTION_LIMIT - state.asked);
  return {
    state,
    systemSuffix: [
      '',
      fresh
        ? 'A NEW round just started — this is the first question. Welcome the player in one line before answering.'
        : `Round in progress: question ${state.asked} of ${QUESTION_LIMIT}, ${remaining} remaining.`,
      remaining === 0
        ? 'The player has now used every question. Invite one final guess, and call give_up if it is wrong.'
        : '',
      '',
      'SECRET APP FACT SHEET (never quote it verbatim, never reveal the name):',
      facts,
    ].join('\n'),
    // Streamed just before 'done' so the browser can carry the round forward.
    onFinish: (send) =>
      send({ type: 'game', token: seal(state), asked: state.asked, remaining, over: state.over === true }),
  };
}

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
    res.status(200).json({ ok: true, hasKey: hasCredentials(), auth: authMode() });
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

    const { message, history, selftest, agent, gameToken } = req.body ?? {};

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
    if (gameToken !== undefined && !(typeof gameToken === 'string' && gameToken.length <= MAX_TOKEN_CHARS)) {
      res.status(400).json({ error: 'gameToken must be a string' });
      return;
    }
    if (!hasCredentials()) {
      res.status(503).json({ error: 'Agent not configured: credentials are missing.' });
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
      // Only the game agent carries per-turn state; everything else is stateless.
      const context = agent === 'guess' ? await gameContext(gameToken) : undefined;
      await runAgentStream(agent, sanitizeHistory(history ?? []), message.trim(), emit, ac.signal, context);
    } catch (err) {
      if (!ac.signal.aborted) {
        console.error('agent stream failed:', err);
        emit({ type: 'error', error: isRateLimit(err) ? RATE_LIMIT_MSG : 'Agent request failed.' });
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
