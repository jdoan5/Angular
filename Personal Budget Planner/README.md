# Personal Budget Planner

A client-side personal finance tracker built with **Angular 22** (standalone
components + signals). Track income and expenses, set monthly budgets per
category, and watch a live dashboard — all stored in the browser via
`localStorage`, no backend required.

## Features

- **Dashboard** — total balance, monthly income/expenses/net, savings rate, a
  custom SVG donut chart of spending by category, budget progress, and recent
  activity.
- **Transactions** — add / edit / delete income and expenses, filter by type,
  and search. New entries can be opened straight from the dashboard.
- **Budgets** — set a monthly spending limit per category with live
  spent-vs-limit bars that turn red when you go over.
- **Persistence** — everything is saved to `localStorage` and reloads on
  return. Sample data is seeded on first run.

## Architecture

- `services/budget-store.ts` — single source of truth. Holds transactions and
  budgets as signals, derives all totals via `computed`, and persists every
  change through an `effect`.
- `services/storage.ts` — fail-safe JSON wrapper around `localStorage`.
- `models/` — `Transaction`, `CategoryBudget`, and the category catalogue
  (names, colours, emoji icons).
- `components/` — `dashboard`, `transactions`, `budgets` (lazy-loaded routes),
  plus a reusable `transaction-form` modal and dependency-free `donut-chart`.
- Styling is hand-rolled SCSS with a small design-token system in
  `src/styles.scss`.

## Development

```bash
npm install
npm start      # ng serve → http://localhost:4200
npm run build  # production build
npm test       # unit tests (Vitest)
```
