# Hangman Encyclopedia

Hangman with a collection meta-game, built with **Angular 22** (standalone
components + signals). Every word you solve unlocks a real "did you know"
entry in your personal encyclopedia — 434 fact-checked entries across 12
volumes, all stored client-side in `localStorage`. Light and dark themes
included.

## How it plays

- **Pick a volume** — Animals, Geography, Science, History, Space,
  Arts & Literature, Food & Drink, Sports & Games, Mythology, Music,
  Inventions, or Human Body.
- **Solve the word** — classic hangman with 6 misses, an on-screen keyboard,
  and full physical-keyboard support. A hint is available, but it costs one
  miss (and is never allowed to be the losing one).
- **Earn the entry** — win and the word joins *My Encyclopedia* with its fun
  fact; lose and the fact is shown but not collected. Streaks, best streak,
  and win/loss record persist between visits.
- **Read by lamplight** — the ☾/☀ button in the top bar switches to dark
  mode. It follows your OS setting until you choose, and remembers the choice.

## Architecture

- `services/game-store.ts` — the whole game as signals: round state, derived
  misses/tiles via `computed`, and stats + collection persisted through
  `effect`s.
- `services/theme.ts` — light/dark theme as signals: follows
  `prefers-color-scheme` until overridden, persists the choice, and stamps
  `<html data-theme>`. A tiny inline script in `index.html` applies the saved
  theme before first paint so there's no flash.
- `data/banks/*.ts` — 12 word banks (word, hint, fact, difficulty) drafted by
  a multi-agent pipeline, fact-checked twice against web sources, playtested
  for hint leaks and difficulty, then validated before being committed.
  `data/word-banks.spec.ts` guards the rules (pattern, unique ids, no hint
  leaks, no cross-volume repeats).
- `components/` — `play` (category picker + game board), `encyclopedia`
  (the collection), `gallows` (dependency-free ink-style SVG, one body part
  per miss), `keyboard` (self-colouring hit/miss keys).
- Lazy-loaded standalone routes; hand-rolled SCSS with a vintage-encyclopedia
  design-token system (parchment, ink, Fraunces serif) and a dark "umber
  paper, parchment ink" palette swapped in under `[data-theme='dark']`.

## Development

```bash
npm install
npm start      # ng serve → http://localhost:4200
npm run build  # production build
npm test       # unit tests (Vitest)
```

Deployed via Vercel — config pinned in `vercel.json`.
