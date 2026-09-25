// Generate the Screenshot Tour snapshot: one live tour per visible app,
// written to agent-core/tours.snapshot.json for John to review and commit.
// Every visitor is then served that reviewed tour for free, until the app's
// next release changes its tourKey.
//
//   node scripts/tour-snapshot.mjs                   all visible apps
//   node scripts/tour-snapshot.mjs --only=6801322941 one app, others kept
//
// LOCAL ONLY. It spends real Gemini quota (about 5K prompt tokens per app,
// twice when a tour needs its retry) on the key in .env.local, so it refuses
// to run in CI, and nothing in package.json or a workflow calls it.

import { writeFileSync, readFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateTour, listTourApps, SNAPSHOT_FILE } from '../agent-core/tours.mjs';
import { hasCredentials } from '../agent-core/client.mjs';

// Between apps, so a run of 14 image calls is spread over ~5 minutes instead
// of landing in one burst on a free-tier per-minute quota. Sequential for the
// same reason. The instance ceiling (20 live tours an hour) also covers a full
// run of 14 with room to spare.
const PAUSE_MS = 20_000;

if (process.env.CI) {
  console.error('tour-snapshot is local only: it spends Gemini quota. Not running in CI.');
  process.exit(1);
}
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)));
} catch {
  /* no .env.local: the credential check below says what is missing */
}
if (!hasCredentials()) {
  console.error('No Gemini credentials: set GEMINI_API_KEY (or GEMINI_AUTH=adc) in .env.local.');
  process.exit(1);
}

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? Number(onlyArg.slice('--only='.length)) : null;
if (onlyArg && !Number.isSafeInteger(only)) {
  console.error(`--only needs a numeric App Store id, got "${onlyArg.slice(7)}"`);
  process.exit(1);
}

const apps = await listTourApps();
const targets = only === null ? apps : apps.filter((a) => a.appId === only);
if (!targets.length) {
  console.error(`${only} is not in the tour (hidden, not John's, or too few screenshots).`);
  process.exit(1);
}

let existing = {};
try {
  existing = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
} catch {
  /* first run: start empty */
}
const visible = new Set(apps.map((a) => String(a.appId)));
// A full run drops entries for apps that left the tour (hidden, removed);
// --only leaves every other entry exactly as it was.
const out = only === null
  ? Object.fromEntries(Object.entries(existing).filter(([id]) => visible.has(id)))
  : { ...existing };

const save = () => {
  // Catalog order, so a regenerated file diffs cleanly against the last one.
  const ordered = {};
  for (const a of apps) if (Object.hasOwn(out, String(a.appId))) ordered[a.appId] = out[a.appId];
  for (const [id, entry] of Object.entries(out)) if (!Object.hasOwn(ordered, id)) ordered[id] = entry;
  const tmp = fileURLToPath(new URL('./tours.snapshot.json.tmp', SNAPSHOT_FILE));
  writeFileSync(tmp, `${JSON.stringify(ordered, null, 2)}\n`);
  renameSync(tmp, SNAPSHOT_FILE);
};

const failed = [];
for (const [i, app] of targets.entries()) {
  if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
  console.log(`\n[${i + 1}/${targets.length}] ${app.name} (${app.appId}) v${app.version} · ${app.tourKey}`);
  try {
    const { tour, receipt } = await generateTour({ appId: app.appId, fresh: true }, undefined, (e) => {
      if (e.type === 'tool-end') console.log(`  ${e.tool.padEnd(17)} ${e.summary}`);
    });
    out[app.appId] = { tour, receipt };
    save();   // after every app, so a failure later keeps this one
    const reasons = Object.entries(tour.dropped.reasons).map(([r, c]) => `${c} ${r}`).join(', ');
    console.log(`  kept ${tour.callouts.length} · dropped ${tour.dropped.count}${reasons ? ` (${reasons})` : ''}`
      + ` · ${receipt.attempts} attempt${receipt.attempts === 1 ? '' : 's'} · ${(receipt.ms / 1000).toFixed(1)} s`
      + ` · ${receipt.promptTokenCount.toLocaleString('en-US')} prompt tokens`);
    // Everything a reviewer needs to judge the tour before committing it.
    for (const c of tour.callouts) {
      console.log(`    shot ${c.shot + 1} [${c.box_2d.join(',')}] ${c.label} — "${c.quote}"`);
    }
  } catch (err) {
    failed.push(app.name);
    console.log(`  FAILED: ${err?.code ?? ''} ${err?.message ?? err}`);
  }
}

console.log(`\n${targets.length - failed.length} of ${targets.length} tours written to ${fileURLToPath(SNAPSHOT_FILE)}`);
if (failed.length) {
  console.log(`Failed (previous entry kept, if any): ${failed.join(', ')}`);
  process.exitCode = 1;
}
console.log('Review every callout above, then commit agent-core/tours.snapshot.json.');
