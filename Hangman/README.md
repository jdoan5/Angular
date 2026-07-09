# Hangman Encyclopedia

Hangman with a collection meta-game, built with **Angular 22** (standalone
components + signals). Every word you solve unlocks a real "did you know"
entry in your personal encyclopedia — 194 fact-checked entries across 8
categories, all stored client-side in `localStorage`.

## How it plays

- **Pick a volume** — Animals, Geography, Science, History, Space,
  Arts & Literature, Food & Drink, or Sports & Games.
- **Solve the word** — classic hangman with 6 misses, an on-screen keyboard,
  and full physical-keyboard support. A hint is available, but it costs one
  miss (and is never allowed to be the losing one).
- **Earn the entry** — win and the word joins *My Encyclopedia* with its fun
  fact; lose and the fact is shown but not collected. Streaks, best streak,
  and win/loss record persist between visits.

## Architecture

- `services/game-store.ts` — the whole game as signals: round state, derived
  misses/tiles via `computed`, and stats + collection persisted through
  `effect`s.
- `data/banks/*.ts` — 8 word banks (word, hint, fact, difficulty) generated
  and fact-checked by a multi-agent pipeline, then validated (pattern, hint
  leaks, duplicates) before being committed.
- `components/` — `play` (category picker + game board), `encyclopedia`
  (the collection), `gallows` (dependency-free ink-style SVG, one body part
  per miss), `keyboard` (self-colouring hit/miss keys).
- Lazy-loaded standalone routes; hand-rolled SCSS with a vintage-encyclopedia
  design-token system (parchment, ink, Fraunces serif).

## Development

```bash
npm install
npm start      # ng serve → http://localhost:4200
npm run build  # production build
npm test       # unit tests (Vitest)
```

Deployed via Vercel — config pinned in `vercel.json`.
