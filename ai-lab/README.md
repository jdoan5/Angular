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
  · list_my_apps           all my published apps + ratings
  · get_app_details        store metadata for one app
  · get_app_reviews        recent public customer reviews
  · get_competitor_reviews live reviews for the apps Review Radar tracks
Review Radar gold snapshot (review-radar/public/gold_snapshot.json on GitHub)
  · get_market_overview    per-app volume, written-review average, store rating
  · get_version_ratings    rating by app version, with deltas computed server-side
  · get_rating_trend       recent weeks vs the weeks before, with enough_data flags
```

Review Radar is my Databricks lakehouse (bronze → silver → gold) of App Store
reviews for five habit apps that my Apple Watch habit tracker Streak Rings
competes with, plus Duolingo as a high-volume control. A daily GitHub Action
commits its gold aggregates as JSON; the Analyst reads that file, so the
lakehouse never has to be awake to answer. Aggregates only, by design: the
published snapshot carries no review text and no author names, and the live
feed tools drop author names too (`agent-core/radar.mjs`).

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

### Screenshot Tour: pins that have to quote the listing

```
Angular 22 UI (app strip + screenshots with numbered pins)
        │  GET  /api/tour                  the strip: catalog only, no model, edge-cached
        │  GET  /api/tour?app=<id>&key=…   a ready tour: reviewed snapshot or instance cache, no model
        │  POST /api/tour  (NDJSON)        "Watch it live": a fresh tour, streamed as a trace
        ▼
agent-core/tours.mjs
  · fetch_screenshots   up to 4 iPhone screenshots in App Store order (600x1300 JPEG, mzstatic only)
  · read_listing        the store description
  · gemini              ONE generateContent call: images inline at HIGH resolution + description,
                        responseSchema → callouts {shot, box_2d, label, quote}
  · grounding_check     every box on the screen, every quote verbatim in the description
```

Gemini gets an app's real store screenshots and its store description, and
returns callouts: a box on one screenshot, a short label, and a quote. The
server keeps a callout only if its box is on the screen (not a sliver, not the
status bar) and its quote is really in the description, matched after
normalizing dashes, bullets, whitespace and case. The pin then shows the
description's own words, not the model's copy of them, and the footer counts
what was dropped and why. A tour that does not ground enough pins gets one
corrective retry with the drop reasons, then fails rather than showing
ungrounded pins.

Tours are cached by a key of app id, version and a hash of the exact
screenshot URLs, so a new release retires old tours on its own. Reviewed tours
live in a committed snapshot (`agent-core/tours.snapshot.json`) that I
generate locally with `node scripts/tour-snapshot.mjs` and read before
committing; an app without one for its current screenshots offers only the
live tour. Live tours sit behind the per-IP rate limit plus a ceiling of 20
per hour per instance. Streak Rings is left out on purpose: its store
screenshots show an iPhone UI while its description says it is made only for
Apple Watch, so it stays hidden until the listing is fixed.

## Run locally

```bash
npm install
cp .env.example .env.local     # paste your Gemini API key (aistudio.google.com/apikey)
npm run dev                    # agent API on :8787 + Angular on :4200 (proxied)
```

No key yet? The UI still runs, and `curl -H 'content-type: application/json' -d '{"selftest":true}' localhost:8787/api/agent`
exercises the live iTunes tools and the Review Radar snapshot without Gemini.
`curl localhost:8787/api/tour` lists the Screenshot Tour strip without Gemini too.

## Deploy (Vercel)

Standard Angular deploy plus one env var: set `GEMINI_API_KEY` in Vercel
project settings. Each file in `api/` (`agent.mjs`, `mission.mjs`, `tour.mjs`)
becomes a serverless function automatically.

## The five stages

- **Guess My App** ✅ · twenty questions over the live catalog; hidden state in
  a sealed token, and a prompt the model cannot betray because the answer was
  never in it
- **App Review Analyst** ✅ · agentic tool-calling with a live, streamed trace
  (NDJSON events: tool-start / tool-end / delta / done). My own apps are too
  new to have reviews worth analyzing, so it studies the habit-app market from
  the Review Radar lakehouse and live reviews; the tools do all the arithmetic
  and the model cites counts and the snapshot date
- **Portfolio Concierge** ✅ · grounded Q&A over live store data + a curated
  profile tool; per-agent tool scoping
- **Math Mission Maker** ✅ · schema-constrained generation (`responseSchema` →
  server-validated JSON) rendered as a playable mission, in the style of
  [Cosmic Cadets](https://apps.apple.com/us/app/cosmic-cadets/id6782706983)
- **Screenshot Tour** · multimodal image understanding with grounded pins: one
  call reads up to four real App Store screenshots with the store description,
  and every pin is kept only if its box is on the screen and its quote is
  verbatim in the listing

Five stages, five distinct Gemini patterns: hidden-state hosting, tool loops,
grounding, structured output, and multimodal image understanding.
