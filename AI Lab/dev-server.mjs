// Local stand-in for the Vercel function so `ng serve` + proxy works without
// the vercel CLI. Reads GEMINI_API_KEY from .env.local (never committed).
//   node dev-server.mjs        → http://localhost:8787/api/agent

import { createServer } from 'node:http';
import handler from './api/agent.mjs';

try {
  process.loadEnvFile('.env.local'); // Node ≥ 20.12; fine if the file is absent
} catch {
  /* no .env.local yet — health endpoint will report hasKey:false */
}

// Deliberately NOT process.env.PORT: dev harnesses set that for the web app's
// port and it would collide with ng serve. The proxy targets 8787.
const PORT = process.env.API_PORT || 8787;

createServer(async (req, res) => {
  // Minimal Vercel-compatible shims: json body + res.status().json()
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (obj) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
  };
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
    await handler(req, res);
  } else {
    res.status(404).json({ error: 'not found' });
  }
}).listen(PORT, '127.0.0.1', () => {   // loopback only — never expose the key's usage to the LAN
  console.log(`AI Lab agent dev server → http://localhost:${PORT}/api/agent`);
  console.log(`GEMINI_API_KEY loaded: ${Boolean(process.env.GEMINI_API_KEY)}`);
});
