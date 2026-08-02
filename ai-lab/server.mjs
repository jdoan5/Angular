// Container entry: serves the agent API standalone (no Vercel, no Angular
// dev server). Used by the GKE deployment — the pod authenticates to Vertex
// via Workload Identity (GEMINI_AUTH=adc), so no key is mounted anywhere.
//
//   node server.mjs   → 0.0.0.0:$PORT (default 8080)
//
// Endpoints: /api/agent (GET health, POST chat stream), /api/mission (POST),
// /healthz (liveness/readiness probe — no auth, no model calls).

import { createServer } from 'node:http';
import agentHandler from './api/agent.mjs';
import missionHandler from './api/mission.mjs';

const PORT = Number(process.env.PORT) || 8080;

const server = createServer(async (req, res) => {
  // Everything inside try/catch: a client aborting mid-body rejects the
  // `for await` below, and an unhandled rejection would kill the whole
  // process (and every concurrent stream with it).
  try {
    // Minimal Vercel-compatible shims: json body + res.status().json()
    res.status = (code) => ((res.statusCode = code), res);
    res.json = (obj) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/healthz') {
      res.status(200).json({ ok: true });
      return;
    }
    if (req.method === 'POST') {
      // utf8 decoding via string_decoder so multibyte characters split
      // across chunk boundaries can't be corrupted.
      req.setEncoding('utf8');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 64_000) {
          res.status(413).json({ error: 'request body too large' });
          return;
        }
      }
      try {
        req.body = raw ? JSON.parse(raw) : {};
      } catch {
        res.status(400).json({ error: 'invalid JSON body' });
        return;
      }
    }
    if (req.url?.startsWith('/api/agent')) {
      await agentHandler(req, res);
    } else if (req.url?.startsWith('/api/mission')) {
      await missionHandler(req, res);
    } else {
      res.status(404).json({ error: 'not found' });
    }
  } catch (err) {
    // Aborted uploads land here as ECONNRESET — not worth a log line each.
    if (err?.code !== 'ECONNRESET') console.error('request failed:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'internal error' }));
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {   // all interfaces — this is a container
  console.log(`ai-lab agent server listening on :${PORT}`);
  console.log(`auth mode: ${process.env.GEMINI_AUTH === 'adc' ? 'ADC (Workload Identity)' : process.env.GEMINI_VERTEX === '1' ? 'Vertex API key' : 'AI Studio key'}`);
});

// Graceful rollouts: K8s sends SIGTERM, we stop accepting and drain briefly
// instead of hanging until the 30s SIGKILL.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

// Last-resort backstops: log, don't die silently.
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
