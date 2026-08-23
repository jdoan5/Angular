# Review Radar — public demo of the App Store reviews lakehouse

Angular 22 dashboard over `public/gold_snapshot.json`, which the repo-root
**gold-snapshot** GitHub Action refreshes daily from the Databricks gold
tables (bronze → silver → gold medallion pipeline; see the Azure/Project 1
repo for the lakehouse itself). Charts are hand-rolled SVG — no chart library.

Aggregates only, by design: no review text, no author names.

## Run locally

```bash
npm install
npm start        # http://localhost:4200
```

The page renders from the committed snapshot; no Databricks access needed.

## One-time wiring (do in this order)

1. **GitHub secrets** — repo **Settings → Secrets and variables → Actions →
   New repository secret**, three of them:
   - `DATABRICKS_HOST` — `https://dbc-4662e673-32b4.cloud.databricks.com`
   - `DATABRICKS_TOKEN` — the `github-action-snapshot` PAT (SQL scope)
   - `DATABRICKS_WAREHOUSE_ID` — SQL Warehouses → Serverless Starter
     Warehouse → ID
2. **First snapshot** — repo **Actions** tab → `gold-snapshot` →
   **Run workflow**. Green run = a bot commit updating
   `review-radar/public/gold_snapshot.json` with `rating_by_version` and
   `weekly_velocity` filled in (the committed seed has them empty).
3. **Vercel project** — vercel.com → Add New → Project → import
   `jdoan5/Angular` → **Root Directory: `review-radar`** → Deploy.
   (Same pattern as the other apps in this monorepo.) Every future snapshot
   commit auto-redeploys it.

## Token rotation

The PAT expires (check its lifetime in Databricks → Settings → Developer →
Access tokens). When the Action starts failing with 401/403: generate a new
token with the same name and scope, update the `DATABRICKS_TOKEN` secret,
re-run the workflow. Two minutes.
