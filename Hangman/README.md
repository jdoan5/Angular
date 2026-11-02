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

## Today's Entry

One entry a day, the same for everyone, shown as a card above the volumes.

- **The day** — Daily No. 1 is Monday 2 November 2026 (`DAILY_EPOCH`). The
  day number comes from your *local* calendar date, counted in whole UTC days
  from the epoch, so a 23- or 25-hour DST day never shifts it. Before the
  epoch there is no daily, and the card stays hidden.
- **The schedule** — `data/daily-schedule.ts` lists all 434 ids exactly once:
  62 weeks that start on a Monday. Monday and Tuesday are easy, Wednesday to
  Friday medium, Saturday hard, and Sunday is *the big one*. There are fewer
  hard entries than weekends, so about one Sunday in four is an easy word,
  spread through the year rather than bunched. The same volume never appears
  two days running. Day N plays `DAILY_SCHEDULE[N % length]`, so the order
  loops after No. 434 (No. 435 is Monday 10 January 2028).
- **One attempt** — progress is saved after every guess and hint. Leaving a
  daily round (← Volumes, the brand link, or a refresh) *pauses* it: no loss,
  no streak reset, and **Resume** replays your saved guesses exactly.
  Conceding ends the day as a loss, and a finished day can't be replayed.
  Free play never serves today's daily word.
- **Streaks** — daily wins and losses still count toward your main record,
  streak and encyclopedia. The separate *daily streak* (consecutive solved
  days) and its best are worked out from the saved days, never stored.
- **Share** — a spoiler-free, four-line result: the daily number and volume
  icon, one square per guess in order (🟩 hit, 🟥 miss, 💡 where the hint was
  taken), the outcome, and the site address. Touch devices get the native
  share sheet. Everything else copies to the clipboard. If neither is
  available, the text appears in a pre-selected box to copy by hand.
- **Daily ledger** — once you've played a daily, *My Encyclopedia* shows a
  Monday-first month of stamps (◉ solved, ✕ missed, ◐ in progress), with
  arrows back to the launch month, plus your daily streak and best.

### The `he.daily` key

Saved days live in `localStorage` under `he.daily`, next to `he.stats`,
`he.collection` and `he.theme`:

```ts
Record<'YYYY-MM-DD', {
  id: string;          // the entry played that day
  guesses: string;     // letters in the order guessed, e.g. 'EATRS'
  hintAt: number;      // -1, or how many guesses came before the hint
  result: 'won' | 'lost' | null;  // null while the day is in progress
}>
```

Rows are checked on load, and when another tab saves. A row is dropped if it
doesn't fit this shape, isn't the entry scheduled for its day, or couldn't
have come from real play (a "win" that doesn't solve the word, say). Tabs
merge rather than overwrite, so a finished day is never rewound.

### Regenerating the schedule (append-only)

```bash
npm run daily:schedule                       # check the committed file (read-only)
npm run daily:schedule -- --append           # after adding new entries
npm run daily:schedule -- --append --dry-run # preview without writing
```

`scripts/daily-schedule.mjs` bundles the word banks with esbuild (to a temp
file it deletes afterwards) and deals them out with a seeded PRNG, so the
output is reproducible. `--write` builds the schedule from scratch, but it
was only for the first generation, and it refuses to replace a different
file without `--force`. The published
order is pinned by `DAILY_SCHEDULE_LOCK` (`{ length, hash }`), and a test
fails if the order changes. **Never regenerate or reorder a published
schedule.** That would change today's word for everyone and break old share
lines and ledger rows. When new entries land, run it with `--append`. This
adds them in whole weeks after the last scheduled day and leaves every
earlier day as it was. That only holds before the order first loops: after
No. 434, a longer schedule would move days already played to other entries.
So `--append` refuses from 14 days before the loop (No. 435, Monday 10
January 2028) unless given `--force`. Renaming a word changes its id, and the
schedule test catches that too.

## Accessibility

- The round-over card is a named modal dialog. Its name is the verdict and
  the word, and the fact describes it. Tab and Shift+Tab stay inside it while
  it's open.
- The word reads as one pattern ("A word of 6 letters: M, blank, blank…").
  A single polite narrator outside `<main>` says each guess result in one
  short line, and it never mentions a letter you haven't found.
- Keys say whether a guessed letter was in the word. Hits carry a ✓ and
  misses are struck through, so neither depends on colour.
- The hint button explains why it's unavailable on your last miss.
- Grouped stats are real groups with spoken labels, and decorative emoji are
  hidden from screen readers.
- The daily ledger is a real table: a month caption, weekday column headers,
  a spoken status for each day, and `aria-current="date"` on today. Stamps
  differ by shape as well as colour.
- Every new control is at least 44 px. Animations and transitions switch off
  under `prefers-reduced-motion`.

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
- `services/daily.ts` — Today's Entry: the saved days (`he.daily`), today's
  entry and state, the daily streak, and opening or resuming the daily round.
  `data/daily-schedule.ts` is generated by `scripts/daily-schedule.mjs`.
- `components/` — `play` (category picker + game board), `encyclopedia`
  (the collection), `gallows` (dependency-free ink-style SVG, one body part
  per miss), `keyboard` (self-colouring hit/miss keys), `daily-card` (Today's
  Entry on the home screen, plus the shared *Share result* control) and
  `daily-ledger` (the month of daily stamps in My Encyclopedia).
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
