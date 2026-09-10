# John's AI Lab

Agent demos on **Google Gemini**, built in **Angular 22**, using **live App
Store data**. The landing stage is **Guess My App**: twenty questions played
against my real App Store catalog, where the model is handed a name-redacted
fact sheet and genuinely cannot leak the answer.

## Architecture

```
Angular 22 UI (chat + tool-call trace)
        │  POST /api/agent            ← key never reaches the browser
        ▼
Serverless agent  (api/agent.mjs on Vercel · dev-server.mjs locally)
        │  function-calling loop      agent-core/agent.mjs
        ▼
Google Gemini (@google/genai — AI Studio key by default; GEMINI_VERTEX=1 switches to Vertex express mode)
        │  tool calls
        ▼
Apple iTunes Search & RSS APIs (public, no auth)
  · list_my_apps        all my published apps + ratings
  · get_app_details     store metadata for one app
  · get_app_reviews     recent public customer reviews
```

### Keeping a secret in a stateless app

Guess My App has to hide one fact from a browser that holds the entire
conversation. Three rules do it (`agent-core/game.mjs`):

1. **The model never learns the answer.** It gets a fact sheet with the app's
   name scrubbed out — every colon-separated part and every word inside them,
   matched loosely enough to catch `50/30/20` for "503020: Budget Coach". It
   cannot leak what it does not have.
2. **The secret rides in a sealed token.** AES-256-GCM, opaque to the browser,
   echoed back each turn and reopened server-side. No session store, so it
   survives serverless cold starts. Set `GAME_SECRET` in the deploy
   environment to keep tokens valid across instances; without it each process
   derives its own key and a token from another instance simply starts a new
   round.
3. **Only `check_guess` and `give_up` can reveal it**, server-side, against
   the unsealed state — so the tool trace can show a guess being checked
   without showing what it was checked against.

The UI shows the agent's **tool-call trace** for every answer — you can watch
it decide to list apps, pick an id, and fetch reviews before it writes a word.

## Run locally

```bash
npm install
cp .env.example .env.local     # paste your Gemini API key (aistudio.google.com/apikey)
npm run dev                    # agent API on :8787 + Angular on :4200 (proxied)
```

No key yet? The UI still runs, and `POST /api/agent {"selftest":true}`
exercises the live iTunes tools without Gemini.

## Deploy (Vercel)

Standard Angular deploy plus one env var: set `GEMINI_API_KEY` in Vercel
project settings. `api/agent.mjs` becomes a serverless function automatically.

## The four stages

- **Guess My App** ✅ · twenty questions over the live catalog; hidden state in
  a sealed token, and a prompt the model cannot betray because the answer was
  never in it
- **App Review Analyst** ✅ · agentic tool-calling with a live, streamed trace
  (NDJSON events: tool-start / tool-end / delta / done)
- **Portfolio Concierge** ✅ · grounded Q&A over live store data + a curated
  profile tool; per-agent tool scoping
- **Math Mission Maker** ✅ · schema-constrained generation (`responseSchema` →
  server-validated JSON) rendered as a playable mission, in the style of
  [Cosmic Cadets](https://apps.apple.com/us/app/cosmic-cadets/id6782706983)

Four stages, four distinct Gemini patterns: hidden-state hosting, tool loops,
grounding, and structured output.
