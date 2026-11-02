#!/usr/bin/env node
/**
 * Generates src/app/data/daily-schedule.ts: the fixed order of "Today's Entry".
 *
 *   npm run daily:schedule                      verify the committed file (read-only; the default)
 *   npm run daily:schedule -- --write           generate from scratch (refuses to replace a different file without --force)
 *   npm run daily:schedule -- --append          schedule entries added since, in whole weeks, after the existing days
 *   add --dry-run to --write/--append           compute and compare, never write
 *
 * Day N plays DAILY_SCHEDULE[N % length], so once the schedule has looped, a
 * longer one moves every looped day (played, shared and saved) to another
 * entry. --append therefore refuses from 14 days before the first loop
 * (No. length + 1) unless given --force. To rehearse that check on another
 * date, set DAILY_SCHEDULE_TODAY=YYYY-MM-DD.
 *
 * Rules: every id exactly once, whole Monday-first weeks (Mon+Tue easy,
 * Wed–Fri medium, Sat hard, Sun "the big one": hard, with the few Sundays
 * hard can't cover spread evenly as leftover easy), never the same volume two days running (wrap-around
 * included), and a neighbouring difficulty is borrowed only when a tier is
 * exhausted. A seeded PRNG keeps every run identical.
 *
 * The word banks are TypeScript, so they're bundled with esbuild (already in
 * node_modules via @angular/build) to a temp .mjs that is imported and deleted.
 */
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/app/data/daily-schedule.ts');
const SEED = 20261102;
const MAX_ATTEMPTS = 1000;
/** A fresh generation may borrow this many days at most (about 2 are expected). */
const MAX_BORROWED = 3;
/** Time for an append to ship before the first loop it must not straddle. */
const APPEND_MARGIN_DAYS = 14;

const TIERS = ['easy', 'medium', 'hard'];
/** Wanted tier by weekday, Monday first. Sunday may also take leftover easy. */
const PRIMARY = ['easy', 'easy', 'medium', 'medium', 'medium', 'hard', 'hard'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SUNDAY = 6;

const args = new Set(process.argv.slice(2));
const known = new Set(['--check', '--write', '--append', '--dry-run', '--force']);
for (const arg of args) {
  if (!known.has(arg))
    fail(`Unknown option ${arg}. Use --check, --write, --append, --dry-run, --force.`);
}
if (args.has('--write') && args.has('--append')) fail('Pick one of --write or --append.');
const mode = args.has('--write') ? 'write' : args.has('--append') ? 'append' : 'check';
const dryRun = args.has('--dry-run');

function fail(message) {
  console.error(`✘ ${message}`);
  process.exit(1);
}

/** mulberry32: tiny, fast, and identical on every machine. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, rand) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Bundle the TypeScript sources the generator needs and import them. */
async function loadSources(withSchedule) {
  const lines = [
    "export { WORD_BANKS } from './src/app/data/word-banks';",
    "export { DAILY_EPOCH, addDays, dayNumber, isDayKey, localDayKey, scheduleHash, weekdayIndex } from './src/app/services/daily-math';",
  ];
  if (withSchedule) {
    lines.push(
      "export { DAILY_SCHEDULE, DAILY_SCHEDULE_LOCK } from './src/app/data/daily-schedule';",
    );
  }
  const dir = await mkdtemp(join(tmpdir(), 'daily-schedule-'));
  const outfile = join(dir, 'sources.mjs');
  try {
    await build({
      stdin: {
        contents: lines.join('\n'),
        resolveDir: ROOT,
        loader: 'ts',
        sourcefile: 'daily-sources.ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile,
      logLevel: 'silent',
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Decide each day's tier before any word is drawn. Counts alone settle it, so
 * the plan is the same on every run. Sundays are hard, except the few that
 * hard can't cover once every Saturday is: those take the easy words Mon/Tue
 * can spare, spread evenly through the run (a Bresenham pace) rather than
 * bunched at the end, so no stretch of weeks loses its big one. Any other
 * shortfall borrows from a neighbouring tier.
 */
function planTiers(supply, days) {
  const left = { ...supply };
  const plan = [];
  const sundays = Math.floor(days / 7);
  const easySundays = Math.max(0, sundays - Math.max(0, supply.hard - sundays));
  for (let i = 0; i < days; i++) {
    const weekday = i % 7;
    const primary = PRIMARY[weekday];
    // Later slots that only their own tier can fill (Sundays are flexible).
    const after = { easy: 0, medium: 0, hard: 0 };
    for (let j = i + 1; j < days; j++) {
      if (j % 7 !== SUNDAY) after[PRIMARY[j % 7]]++;
    }
    let tier = primary;
    if (weekday === SUNDAY) {
      const k = Math.floor(i / 7);
      const easyTurn =
        Math.floor(((k + 1) * easySundays) / sundays) > Math.floor((k * easySundays) / sundays);
      // Take the turn's tier if it can spare a word, else the other one.
      const order = easyTurn ? ['easy', 'hard'] : ['hard', 'easy'];
      tier = order.find((t) => left[t] > after[t]) ?? null;
    } else if (left[tier] === 0) {
      tier = null;
    }
    tier ??= borrow(primary, left, after);
    if (!tier) throw new Error(`No entries left for day ${i + 1}.`);
    left[tier]--;
    plan.push({
      tier,
      primary,
      borrowed: tier !== primary && !(weekday === SUNDAY && tier === 'easy'),
    });
  }
  return plan;
}

/** The neighbouring tier with the most to spare (easy ↔ medium ↔ hard), else anything left. */
function borrow(primary, left, after) {
  const neighbours = primary === 'medium' ? ['easy', 'hard'] : ['medium'];
  const spare = (tier) => left[tier] - after[tier];
  const pick = (tiers) =>
    tiers.filter((t) => left[t] > 0).sort((a, b) => spare(b) - spare(a))[0] ?? null;
  return pick(neighbours) ?? pick(TIERS);
}

/** Per tier: volume → its ids, shuffled. Map order follows WORD_BANKS, so it's stable. */
function buildPools(entries, rand) {
  const pools = Object.fromEntries(TIERS.map((tier) => [tier, new Map()]));
  for (const { id, volume, difficulty } of entries) {
    const pool = pools[difficulty];
    if (!pool.has(volume)) pool.set(volume, []);
    pool.get(volume).push(id);
  }
  for (const pool of Object.values(pools)) {
    for (const ids of pool.values()) shuffle(ids, rand);
  }
  return pools;
}

/**
 * Draw one id per planned day. Volumes are weighted by how many words they
 * still hold (squared), so big piles drain early and the tail of each tier
 * stays mixed; a volume seen in the last few days is down-weighted for variety.
 * Returns null on a dead end (only one volume left where it can't go).
 */
function assign(plan, pools, rand, { before = null, wrapTo = null } = {}) {
  const ids = [];
  const recent = [];
  let previous = before;
  let first = wrapTo;
  for (let i = 0; i < plan.length; i++) {
    const last = i === plan.length - 1;
    const options = [...pools[plan[i].tier]].filter(
      ([volume, left]) => left.length > 0 && volume !== previous && !(last && volume === first),
    );
    if (options.length === 0) return null;
    const weights = options.map(
      ([volume, left]) => left.length ** 2 * (recent.includes(volume) ? 0.3 : 1),
    );
    let r = rand() * weights.reduce((sum, w) => sum + w, 0);
    let k = 0;
    for (; k < options.length - 1; k++) {
      r -= weights[k];
      if (r < 0) break;
    }
    const [volume, left] = options[k];
    ids.push(left.pop());
    first ??= volume;
    previous = volume;
    recent.push(volume);
    if (recent.length > 3) recent.shift();
  }
  return ids;
}

/** Schedule `entries` into whole weeks; leftovers (fewer than 7) wait for a later --append. */
function generate(entries, seed, edges) {
  const days = Math.floor(entries.length / 7) * 7;
  // Back-to-back days must differ, so no volume can fill more than every other day.
  const perVolume = new Map();
  for (const { volume } of entries) perVolume.set(volume, (perVolume.get(volume) ?? 0) + 1);
  const [busiest, most] = [...perVolume].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  if (most > Math.ceil(days / 2)) {
    fail(
      `${most} of ${entries.length} entries are in ${busiest}; spread them over more volumes so no two days in a row share one.`,
    );
  }
  const supply = { easy: 0, medium: 0, hard: 0 };
  for (const entry of entries) supply[entry.difficulty]++;
  const plan = planTiers(supply, days);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rand = mulberry32(seed + attempt);
    const ids = assign(plan, buildPools(entries, rand), rand, edges);
    if (ids) return { ids, plan, attempt };
  }
  fail(`No valid order found in ${MAX_ATTEMPTS} attempts.`);
}

function formatKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const weekday = WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
  return `${weekday} ${d} ${MONTHS[m - 1]} ${y}`;
}

/** The generated file. A pure function of the order, so --check can re-render and compare. */
function render(ids, src, byId) {
  const lines = [
    '// GENERATED by scripts/daily-schedule.mjs: do not edit by hand.',
    '// Regenerating from scratch would reshuffle days players have already seen;',
    '// schedule new entries with `npm run daily:schedule -- --append` instead.',
    `// Append before the order first loops, at No. ${ids.length + 1} (${formatKey(src.addDays(src.DAILY_EPOCH, ids.length))}):`,
    '// after that, a longer schedule would move days already played.',
    '',
    '/**',
    " * Today's Entry, in order. Day N (0-based, counted from DAILY_EPOCH in",
    ' * daily-math.ts) plays DAILY_SCHEDULE[N % DAILY_SCHEDULE.length].',
    ' */',
    'export const DAILY_SCHEDULE: readonly string[] = [',
  ];
  ids.forEach((id, i) => {
    const weekday = i % 7;
    if (weekday === 0)
      lines.push(`  // Week ${i / 7 + 1}, from ${formatKey(src.addDays(src.DAILY_EPOCH, i))}`);
    const tier = byId.get(id).difficulty;
    const primary = PRIMARY[weekday];
    const note =
      tier === primary
        ? ''
        : weekday === SUNDAY && tier === 'easy'
          ? ' (leftover easy)'
          : ` (borrowed for ${primary})`;
    lines.push(`  '${id}', // No. ${i + 1} · ${WEEKDAYS[weekday]} · ${tier}${note}`);
  });
  lines.push(
    '];',
    '',
    '/** Pins the published order: daily-schedule.spec.ts fails if it changes. */',
    `export const DAILY_SCHEDULE_LOCK = { length: ${ids.length}, hash: '${src.scheduleHash(ids)}' } as const;`,
    '',
  );
  return lines.join('\n');
}

/** Everything the schedule promises, as a list of problems (empty = valid). */
function validate(ids, byId) {
  const problems = [];
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) problems.push(`Unknown ids: ${unknown.join(', ')}`);
  const seen = new Set();
  const dupes = ids.filter((id) => seen.has(id) || !seen.add(id));
  if (dupes.length) problems.push(`Scheduled twice: ${dupes.join(', ')}`);
  if (ids.length % 7 !== 0) problems.push(`${ids.length} days is not a whole number of weeks.`);
  const volume = (id) => byId.get(id)?.volume;
  ids.forEach((id, i) => {
    const next = ids[(i + 1) % ids.length];
    if (ids.length > 1 && volume(id) && volume(id) === volume(next)) {
      problems.push(`Same volume two days running: No. ${i + 1} ${id} → ${next}`);
    }
  });
  return problems;
}

/** The first day that replays No. 1's entry: 'No. N (Weekday D Mon YYYY)'. */
function loopLabel(length, src) {
  return `No. ${length + 1} (${formatKey(src.addDays(src.DAILY_EPOCH, length))})`;
}

/**
 * Day N plays DAILY_SCHEDULE[N % length], so after the first loop a longer
 * schedule moves every looped day to another entry: share lines and saved
 * ledger rows stop matching (the app drops such rows on load). Refuse to
 * append once the loop is near, unless forced.
 */
function guardLoop(length, src) {
  const todayKey = process.env.DAILY_SCHEDULE_TODAY ?? src.localDayKey(new Date());
  if (!src.isDayKey(todayKey))
    fail(`DAILY_SCHEDULE_TODAY must be a YYYY-MM-DD date, not ${todayKey}.`);
  const today = src.dayNumber(todayKey);
  if (today + APPEND_MARGIN_DAYS < length) return;
  const looped = today >= length;
  const message = looped
    ? `The schedule already looped: ${loopLabel(length, src)} replayed No. 1, and today is No. ${today + 1}. Appending now would move days already played to different entries.`
    : `The schedule loops at ${loopLabel(length, src)}, under ${APPEND_MARGIN_DAYS} days away. If the append ships after that, days already played would move to different entries.`;
  if (!args.has('--force')) fail(`${message}\n  Pass --force to append anyway.`);
  console.log(`  ⚠ ${message} Going ahead (--force).`);
}

function summarize(ids, byId, attempt, src) {
  const borrowed = [];
  const leftoverSundays = [];
  ids.forEach((id, i) => {
    const tier = byId.get(id)?.difficulty;
    const primary = PRIMARY[i % 7];
    if (tier === primary) return;
    if (i % 7 === SUNDAY && tier === 'easy') leftoverSundays.push(i + 1);
    else borrowed.push(`No. ${i + 1} (${WEEKDAYS[i % 7]}) ${primary} → ${tier}`);
  });
  console.log(
    `  ${ids.length} days · ${ids.length / 7} weeks${attempt === undefined ? '' : ` · attempt ${attempt}`}`,
  );
  console.log(
    `  Sundays on leftover easy: ${leftoverSundays.length}${leftoverSundays.length ? ` (from No. ${leftoverSundays[0]})` : ''}`,
  );
  console.log(
    `  Borrowed days: ${borrowed.length}${borrowed.length ? `: ${borrowed.join('; ')}` : ''}`,
  );
  console.log(
    `  Loops at ${loopLabel(ids.length, src)}, which replays No. 1; --append only before then.`,
  );
  return borrowed.length;
}

async function main() {
  const fileExists = existsSync(OUT);
  if (mode !== 'write' && !fileExists)
    fail(`${relative(ROOT, OUT)} does not exist yet; run with --write first.`);

  const src = await loadSources(mode !== 'write');
  if (src.weekdayIndex(src.DAILY_EPOCH) !== 0)
    fail(`DAILY_EPOCH ${src.DAILY_EPOCH} must be a Monday.`);

  const entries = src.WORD_BANKS.flatMap((volume) =>
    volume.entries.map((e) => ({ id: e.id, volume: volume.id, difficulty: e.difficulty })),
  );
  const byId = new Map(entries.map((e) => [e.id, e]));
  const current = fileExists ? await readFile(OUT, 'utf8') : null;

  if (mode === 'check') {
    const ids = [...src.DAILY_SCHEDULE];
    const problems = validate(ids, byId);
    const missing = entries.filter((e) => !ids.includes(e.id));
    if (missing.length)
      problems.push(`${missing.length} entries not scheduled yet; run with --append.`);
    const lock = src.DAILY_SCHEDULE_LOCK;
    if (lock.length !== ids.length || lock.hash !== src.scheduleHash(ids)) {
      problems.push('DAILY_SCHEDULE_LOCK does not match the order: the file was edited by hand.');
    }
    if (!problems.length && render(ids, src, byId) !== current) {
      problems.push(
        'The file differs from what the generator renders for this order (hand-edited?).',
      );
    }
    console.log(`Checking ${relative(ROOT, OUT)}`);
    summarize(ids, byId, undefined, src);
    if (problems.length) fail(problems.join('\n  '));
    console.log(`✔ Valid and unchanged · lock ${lock.hash}`);
    return;
  }

  let ids;
  let attempt;
  let leftover = [];
  if (mode === 'write') {
    ({ ids, attempt } = generate(entries, SEED));
    leftover = entries.filter((e) => !ids.includes(e.id));
  } else {
    const existing = [...src.DAILY_SCHEDULE];
    const problems = validate(existing, byId);
    if (problems.length) fail(`Fix the existing schedule first:\n  ${problems.join('\n  ')}`);
    const fresh = entries.filter((e) => !existing.includes(e.id));
    if (fresh.length < 7) {
      console.log(
        `Nothing to append: ${fresh.length} unscheduled ${fresh.length === 1 ? 'entry' : 'entries'} (a week needs 7).`,
      );
      return;
    }
    guardLoop(existing.length, src);
    // New weeks follow on from the last scheduled day and must not clash with day 1 on wrap-around.
    const edges = {
      before: byId.get(existing.at(-1)).volume,
      wrapTo: byId.get(existing[0]).volume,
    };
    const added = generate(fresh, SEED + existing.length, edges);
    ids = [...existing, ...added.ids];
    attempt = added.attempt;
    leftover = fresh.filter((e) => !added.ids.includes(e.id));
  }

  const problems = validate(ids, byId);
  if (problems.length) fail(`Generated an invalid schedule:\n  ${problems.join('\n  ')}`);
  console.log(`${mode === 'write' ? 'Generated' : 'Appended'} ${relative(ROOT, OUT)}`);
  const borrowed = summarize(ids, byId, attempt, src);
  if (mode === 'write' && borrowed > MAX_BORROWED)
    fail(`${borrowed} borrowed days (limit ${MAX_BORROWED}).`);
  if (leftover.length) {
    console.log(
      `  ⚠ Not scheduled yet (fewer than a week): ${leftover.map((e) => e.id).join(', ')}`,
    );
  }

  const output = render(ids, src, byId);
  const hash = src.scheduleHash(ids);
  if (output === current) {
    console.log(`✔ Identical to the committed file · lock ${hash}`);
    return;
  }
  if (dryRun) {
    console.log(
      `✘ Dry run: would ${current === null ? 'create' : 'change'} the committed file (new lock ${hash}). Nothing written.`,
    );
    process.exitCode = 1;
    return;
  }
  if (mode === 'write' && current !== null && !args.has('--force')) {
    fail(
      'Refusing to replace the published schedule. Use --append for new entries, or --force to reshuffle.',
    );
  }
  await writeFile(OUT, output);
  console.log(`✔ Wrote ${ids.length} days · lock ${hash}`);
}

await main();
