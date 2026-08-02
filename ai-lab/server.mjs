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

createServer(async (req, res) => {
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
}).listen(PORT, '0.0.0.0', () => {   // all interfaces — this is a container
  console.log(`ai-lab agent server listening on :${PORT}`);
  console.log(`auth mode: ${process.env.GEMINI_AUTH === 'adc' ? 'ADC (Workload Identity)' : process.env.GEMINI_VERTEX === '1' ? 'Vertex API key' : 'AI Studio key'}`);
});
