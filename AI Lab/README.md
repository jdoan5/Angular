# John's AI Lab

Agent demos on **Vertex AI (Gemini)**, built in **Angular 22**, using **live App
Store data**. Stage 1 is the **App Review Analyst**: an agent with
function-calling tools that lists my published iOS apps, pulls their public
reviews and ratings, analyzes sentiment and themes, and drafts developer
replies.

## Architecture

```
Angular 22 UI (chat + tool-call trace)
        │  POST /api/agent            ← key never reaches the browser
        ▼
Serverless agent  (api/agent.mjs on Vercel · dev-server.mjs locally)
        │  function-calling loop      agent-core/agent.mjs
        ▼
Gemini (Vertex AI express mode, @google/genai)
        │  tool calls
        ▼
Apple iTunes Search & RSS APIs (public, no auth)
  · list_my_apps        all my published apps + ratings
  · get_app_details     store metadata for one app
  · get_app_reviews     recent public customer reviews
```

The UI shows the agent's **tool-call trace** for every answer — you can watch
it decide to list apps, pick an id, and fetch reviews before it writes a word.

## Run locally

```bash
npm install
cp .env.example .env.local     # paste your Vertex AI express-mode API key
npm run dev                    # agent API on :8787 + Angular on :4200 (proxied)
```

No key yet? The UI still runs, and `POST /api/agent {"selftest":true}`
exercises the live iTunes tools without Gemini.

## Deploy (Vercel)

Standard Angular deploy plus one env var: set `GEMINI_API_KEY` in Vercel
project settings. `api/agent.mjs` becomes a serverless function automatically.

## Roadmap

- **Stage 1 — App Review Analyst** ✅
- **Stage 2 — Portfolio Concierge**: grounded Q&A about all my apps
- **Stage 3 — Math Mission Maker**: structured-output word problems in the
  style of [Cosmic Cadets](https://apps.apple.com/us/app/cosmic-cadets/id6782706983)
