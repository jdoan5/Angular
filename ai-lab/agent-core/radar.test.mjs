// Review Radar tools: deterministic math on fixtures, then live checks
// against the real snapshot and iTunes. No Gemini.
//   node --test agent-core/radar.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRACKED, radarTools, resolveApp, clampWeeks, validateSnapshot, sourceOf,
  marketOverview, versionRatings, ratingTrend, loadSnapshot, shapeReviews,
  getMarketOverview, getVersionRatings, getRatingTrend, getCompetitorReviews,
  _setFetcherForTests, _setLookupForTests, _resetCacheForTests,
} from './radar.mjs';
import { toolRegistry, getReviewFeed } from './tools.mjs';
import { gameTools } from './game.mjs';
import { AGENTS } from './agents.mjs';
import { runAgentStream } from './agent.mjs';

const HT = 'Habit Tracker';
const ATOMS = 'Atoms - from Atomic Habits';
const KIT = 'HabitKit';
const DUO = 'Duolingo (high-volume control)';

const wk = (app, week, n, avg, partial = false) =>
  ({ app_name: app, week: `${week}T00:00:00.000Z`, n_reviews: n, avg_rating: avg, is_partial_week: partial });

// Exported Thursday 2026-09-24, so the latest complete week is 2026-09-14.
const fixture = () => ({
  generated_at: '2026-09-24T12:00:00Z',
  totals: { reviews_collected: 400, overall_avg_rating: 4, apps_tracked: 4 },
  overview: [
    { app_name: HT, reviews_collected: 250, avg_rating: 4.1, versions_seen: 9, oldest_review_at: '2025-01-01T00:00:00Z', newest_review_at: '2026-09-16T08:00:00Z' },
    { app_name: ATOMS, reviews_collected: 60, avg_rating: 3.7, versions_seen: 4, oldest_review_at: '2024-02-22T00:00:00Z', newest_review_at: '2026-07-29T19:50:20Z' },
    { app_name: DUO, reviews_collected: 80, avg_rating: 3.8, versions_seen: 3, oldest_review_at: '2026-08-01T00:00:00Z', newest_review_at: '2026-09-23T07:00:00Z' },
    { app_name: KIT, reviews_collected: 10, avg_rating: 4.6, versions_seen: 2, oldest_review_at: '2026-08-01T00:00:00Z', newest_review_at: '2026-09-10T00:00:00Z' },
  ],
  rating_by_version: [
    // Deliberately out of order: the tool sorts by first_review_at.
    { app_name: ATOMS, app_version: '1.2.0', n_reviews: 41, avg_rating: 2.63, first_review_at: '2024-03-22T00:00:00Z' },
    { app_name: ATOMS, app_version: '1.0.3', n_reviews: 164, avg_rating: 4.3, first_review_at: '2024-02-24T00:00:00Z' },
    { app_name: ATOMS, app_version: '3.5.0', n_reviews: 34, avg_rating: 3.59, first_review_at: '2026-02-17T00:00:00Z' },
    { app_name: ATOMS, app_version: '1.0.4', n_reviews: 118, avg_rating: 3.97, first_review_at: '2024-02-27T00:00:00Z' },
    { app_name: KIT, app_version: '1.14.4', n_reviews: 22, avg_rating: 4.59, first_review_at: '2025-12-27T00:00:00Z' },
  ],
  weekly_velocity: [
    wk(HT, '2026-08-17', 3, 1.0, true), // first week of data: partial, excluded
    wk(HT, '2026-08-24', 10, 4.0),
    wk(HT, '2026-08-31', 30, 5.0),
    wk(HT, '2026-09-07', 15, 3.0),
    wk(HT, '2026-09-14', 5, 5.0),
    wk(HT, '2026-09-21', 100, 1.0, true), // week in progress: excluded
    wk(ATOMS, '2026-07-20', 25, 4.0),
    wk(ATOMS, '2026-07-27', 25, 2.0),
    wk(KIT, '2026-08-17', 2, 4.0), // Aug 24 had none: normal at this volume
    wk(KIT, '2026-08-31', 3, 5.0),
    wk(KIT, '2026-09-07', 2, 4.0),
    // High volume with a lost week (Aug 31), as ingestion pauses leave it.
    wk(DUO, '2026-08-17', 900, 3.7),
    wk(DUO, '2026-08-24', 950, 3.7),
    wk(DUO, '2026-09-07', 550, 3.9),
    wk(DUO, '2026-09-14', 600, 3.8),
  ],
});

// ------------------------------------------------------------------ pure math

test('trend: n-weighted windows anchored on the latest complete week, partial weeks dropped', () => {
  const t = ratingTrend(fixture(), HT, 2);
  assert.deepEqual(t.recent, { from: '2026-09-07', to: '2026-09-20', avg: 3.5, n: 20, weeks_with_data: 2 });
  assert.deepEqual(t.prior, { from: '2026-08-24', to: '2026-09-06', avg: 4.75, n: 40, weeks_with_data: 2 });
  assert.equal(t.delta, -1.25);
  assert.equal(t.low_n, false, '20 is enough');
  assert.equal(t.prior_window_covered, true);
  assert.equal(t.enough_data, true);
  assert.equal(t.ingestion_gap_suspected, false);
  assert.equal(t.newest_review_at, '2026-09-16');
});

test('trend: the delta is the difference of the averages it is shown beside', () => {
  // Averages that do not round evenly: 13/3 = 4.333 and 11/3 = 3.667. From the
  // unrounded values the delta would be 0.67 beside 4.33 and 3.67.
  const s = fixture();
  s.weekly_velocity = [
    wk(HT, '2026-08-17', 1, 4.0),
    wk(HT, '2026-08-24', 1, 3.0), wk(HT, '2026-08-31', 2, 4.0),
    wk(HT, '2026-09-07', 1, 5.0), wk(HT, '2026-09-14', 2, 4.0),
  ];
  const t = ratingTrend(s, HT, 2);
  assert.equal(t.recent.avg, 4.33);
  assert.equal(t.prior.avg, 3.67);
  assert.equal(t.delta, 0.66);
});

test('trend: a missing week for a high-volume app is an ingestion gap, not a trend', () => {
  const t = ratingTrend(fixture(), DUO, 2);
  assert.equal(t.prior.weeks_with_data, 1, 'Aug 31 is missing');
  assert.equal(t.low_n, false);
  assert.equal(t.prior_window_covered, true);
  assert.equal(t.ingestion_gap_suspected, true);
  assert.equal(t.enough_data, false);
});

test('trend: a missing week at a few reviews a week is not an ingestion gap', () => {
  const t = ratingTrend(fixture(), KIT, 2);
  assert.equal(t.prior.weeks_with_data, 1, 'Aug 24 is missing');
  assert.equal(t.prior_window_covered, true);
  assert.equal(t.ingestion_gap_suspected, false);
});

test('trend: an unparseable newest review date falls back to the export week', () => {
  const s = fixture();
  s.overview[0].newest_review_at = 'garbage';
  const t = ratingTrend(s, HT, 2);
  assert.equal(t.recent.to, '2026-09-20');
});

test('trend: a prior window that starts before the data is not enough data', () => {
  // Aug 10-30 holds one full week (Aug 24) but starts before the series does.
  const t = ratingTrend(fixture(), HT, 3);
  assert.deepEqual(t.prior, { from: '2026-08-10', to: '2026-08-30', avg: 4, n: 10, weeks_with_data: 1 });
  assert.equal(t.prior_window_covered, false);
  assert.equal(t.ingestion_gap_suspected, false, 'weeks before the data are uncovered, not a gap');
  assert.equal(t.enough_data, false);
});

test('trend: an empty prior window is null, never NaN', () => {
  const t = ratingTrend(fixture(), HT, 4);
  assert.deepEqual(t.prior, { from: '2026-07-27', to: '2026-08-23', avg: null, n: 0, weeks_with_data: 0 });
  assert.equal(t.delta, null);
  assert.equal(t.enough_data, false);
  assert.ok(!JSON.stringify(t).includes('NaN'));
});

test("trend: windows end at the app's newest review, not in a gap after it", () => {
  const t = ratingTrend(fixture(), ATOMS, 1);
  assert.equal(t.recent.from, '2026-07-27');
  assert.equal(t.recent.to, '2026-08-02');
  assert.equal(t.recent.avg, 2);
  assert.equal(t.prior.avg, 4);
  assert.equal(t.delta, -2);
  assert.equal(t.enough_data, true);
});

test('trend: low review counts are flagged, not reported as a trend', () => {
  const t = ratingTrend(fixture(), KIT, 1);
  assert.equal(t.low_n, true);
  assert.equal(t.enough_data, false);
});

test('clampWeeks: integers clamped to 1-26, non-numbers refused', () => {
  assert.equal(clampWeeks(undefined), 4);
  assert.equal(clampWeeks(null), 4);
  assert.equal(clampWeeks(0), 1);
  assert.equal(clampWeeks(-3), 1);
  assert.equal(clampWeeks(999), 26);
  assert.equal(clampWeeks(2.5), 3);
  assert.equal(clampWeeks('4'), 4);
  assert.equal(clampWeeks('abc'), null);
  assert.equal(clampWeeks(Infinity), null);
});

test('versions: sorted by first review, deltas, gap_days, biggest drop and rise', () => {
  const v = versionRatings(fixture(), ATOMS);
  assert.deepEqual(v.versions.map((x) => x.version), ['1.0.3', '1.0.4', '1.2.0', '3.5.0']);
  assert.equal(v.versions[0].delta, null);
  assert.equal(v.versions[1].delta, -0.33);
  assert.equal(v.versions[1].gap_days, 3);
  assert.deepEqual(v.biggest_drop, { from: '1.0.4', to: '1.2.0', delta: -1.34, n_from: 118, n_to: 41, gap_days: 24 });
  assert.deepEqual(v.biggest_rise, { from: '1.2.0', to: '3.5.0', delta: 0.96, n_from: 41, n_to: 34, gap_days: 697 });
  assert.equal(v.newest_review_at, '2026-07-29', "the app's own reach, not another app's");
  assert.match(v.note, /not necessarily the current release/);
});

test('versions: a single listed version has no deltas', () => {
  const v = versionRatings(fixture(), KIT);
  assert.equal(v.versions.length, 1);
  assert.equal(v.versions[0].delta, null);
  assert.equal(v.biggest_drop, null);
  assert.equal(v.biggest_rise, null);
});

test('overview: store fields merged by id, control last, untracked apps kept and marked', () => {
  const s = fixture();
  s.overview.push({ app_name: 'Renamed In Databricks', reviews_collected: 999, avg_rating: 4, versions_seen: 1, oldest_review_at: null, newest_review_at: null });
  const store = new Map([[TRACKED[HT].appId, { trackName: HT, averageUserRating: 4.79204, userRatingCount: 147200 }]]);
  const o = marketOverview(s, store);
  assert.equal(o.apps.at(-1).app, DUO);
  const ht = o.apps.find((a) => a.app === HT);
  assert.equal(ht.store_rating, 4.79);
  assert.equal(ht.store_rating_count, 147200);
  assert.equal(ht.written_review_avg, 4.1);
  assert.ok(!('store_rating' in o.apps.find((a) => a.app === ATOMS)), 'no store row, no store fields');
  assert.equal(o.apps.find((a) => a.app === 'Renamed In Databricks').role, 'untracked');
  assert.ok(!('store_rating' in marketOverview(fixture(), null).apps[0]), 'lookup failed: fields omitted');
});

test('source: as_of, age, the 2-day stale threshold, no snapshot-wide review date', () => {
  const s = fixture();
  const at = Date.parse(s.generated_at);
  const fresh = sourceOf(s, false, at + 1.5 * 86_400_000);
  assert.equal(fresh.as_of, '2026-09-24');
  assert.equal(fresh.age_days, 1);
  assert.equal(fresh.stale, false);
  assert.ok(!('latest_review_at' in fresh), 'no snapshot-wide date on per-app results');
  assert.ok(!('fetch_error' in fresh));
  assert.equal(sourceOf(s, false, at + 2 * 86_400_000).stale, true);
  assert.equal(sourceOf(s, true, at).fetch_error, true);
});

test('validateSnapshot rejects a snapshot missing its keys', () => {
  assert.throws(() => validateSnapshot({ generated_at: '2026-09-24T00:00:00Z', overview: [] }));
  assert.throws(() => validateSnapshot({ ...fixture(), generated_at: 'not a date' }));
  assert.ok(validateSnapshot(fixture()));
});

// ------------------------------------------------------------------ argument checks

test('app names: own keys and short names only, prototype keys refused', () => {
  assert.equal(resolveApp('finch'), 'Finch: Self-Care Pet');
  assert.equal(resolveApp(ATOMS), ATOMS);
  assert.equal(resolveApp(' HabitKit '), KIT);
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'Streak Rings', '', 42, null, {}]) {
    assert.equal(resolveApp(bad), null, String(bad));
  }
});

test('tools refuse bad arguments before any request is made', async () => {
  let fetches = 0;
  _setFetcherForTests(() => { fetches++; throw new Error('must not fetch'); });
  _resetCacheForTests();
  try {
    for (const args of [{ app: '__proto__' }, { app: 'constructor' }, { app: 'Streak Rings' }, {}]) {
      // The app check itself, not a snapshot failure that also reads as an error.
      assert.match((await getVersionRatings(args)).error, /app must be one of/, JSON.stringify(args));
      assert.match((await getRatingTrend(args)).error, /app must be one of/, JSON.stringify(args));
      assert.match((await getCompetitorReviews(args)).error, /app must be one of/, JSON.stringify(args));
    }
    assert.equal(fetches, 0);
    assert.match((await getRatingTrend({ app: KIT, weeks: 'abc' })).error, /weeks/);
    for (const page of [0, 11, 2.5, 'x', -1]) {
      assert.match((await getCompetitorReviews({ app: KIT, page })).error, /page/, String(page));
    }
    for (const max_rating of [0, 6, 1.5, 'x']) {
      assert.match((await getCompetitorReviews({ app: KIT, max_rating })).error, /max_rating/, String(max_rating));
    }
    assert.match((await getCompetitorReviews({ app: KIT, sort: 'newest' })).error, /sort/);
    assert.equal(fetches, 0, 'no argument error reached the network');
  } finally {
    _setFetcherForTests(null);
    _resetCacheForTests();
  }
});

test('declarations: zero-arg tool omits parameters, app params enumerate TRACKED', () => {
  assert.ok(!('parameters' in radarTools.get_market_overview));
  for (const name of ['get_version_ratings', 'get_rating_trend', 'get_competitor_reviews']) {
    assert.deepEqual(radarTools[name].parameters.properties.app.enum, Object.keys(TRACKED), name);
  }
});

test('agents: every listed tool exists, and only the Analyst gained radar tools', () => {
  const all = { ...toolRegistry, ...gameTools, ...radarTools };
  for (const [id, agent] of Object.entries(AGENTS)) {
    for (const t of agent.tools) assert.ok(all[t], `${id}: ${t}`);
  }
  for (const t of Object.keys(radarTools)) assert.ok(AGENTS.reviews.tools.includes(t), t);
  assert.deepEqual(AGENTS.concierge.tools, ['list_my_apps', 'get_app_details', 'get_developer_profile']);
  assert.deepEqual(AGENTS.guess.tools, ['check_guess', 'give_up']);
});

test('trend: a clamped or rounded window says so', async () => {
  _setFetcherForTests(async () => fixture());
  _resetCacheForTests();
  try {
    const t = await getRatingTrend({ app: HT, weeks: 52 });
    assert.equal(t.weeks, 26);
    assert.equal(t.requested_weeks, 52);
    assert.equal(t.weeks_note, 'Clamped to the maximum of 26 weeks (the range is 1 to 26).');
    assert.equal((await getRatingTrend({ app: HT, weeks: 0 })).weeks_note, 'Clamped to the minimum of 1 week (the range is 1 to 26).');
    assert.equal((await getRatingTrend({ app: HT, weeks: 2.5 })).weeks_note, 'Rounded to 3 weeks (the range is 1 to 26).');
    assert.ok(!('requested_weeks' in (await getRatingTrend({ app: HT, weeks: 4 }))));
    assert.ok(!('requested_weeks' in (await getRatingTrend({ app: HT, weeks: '4' }))));
  } finally {
    _setFetcherForTests(null);
    _resetCacheForTests();
  }
});

// ------------------------------------------------------------------ reviews

const entry = (rating, text, { title = 'T', version = '1.0', updated = '2026-09-17T18:38:35-07:00' } = {}) => ({
  'im:rating': { label: String(rating) }, title: { label: title }, content: { label: text },
  'im:version': { label: version }, updated: { label: updated }, author: { name: { label: 'Some Person' } },
});

test('reviews: filtered, capped, clipped, UTC dates, never an author', () => {
  const entries = [entry(1, 'x'.repeat(1000)), ...Array.from({ length: 30 }, (_, i) => entry((i % 5) + 1, `review ${i}`))];
  const all = shapeReviews(entries);
  assert.equal(all.matching, 31);
  assert.equal(all.reviews.length, 12);
  assert.equal(all.reviews[0].text.length, 300);
  assert.equal(all.reviews[0].date, '2026-09-18', 'Pacific 18:38 on the 17th is the 18th in UTC');
  const emoji = shapeReviews([entry(3, '😀'.repeat(400), { title: '😀'.repeat(100) })]).reviews[0];
  assert.ok(!/[\ud800-\udbff]…/.test(emoji.title + emoji.text), 'no half emoji before the ellipsis');
  assert.equal(Array.from(emoji.text).length, 300);
  assert.ok(all.reviews.every((r) => !('author' in r)));
  const critical = shapeReviews(entries, 2);
  assert.ok(critical.reviews.every((r) => r.rating <= 2));
  assert.equal(critical.matching, 13);
});

test('reviews: 16 largest-possible results fit well inside the 150K contents cap', () => {
  // Every field at its clip limit. Text made mostly of quotes or backslashes
  // would double in JSON; that is no real review, and the contents cap in
  // agent.mjs still ends such a turn cleanly.
  const huge = Array.from({ length: 50 }, () =>
    entry(1, 'x'.repeat(2000), { title: 'x'.repeat(500), version: '10.100.1000', updated: '2026-09-17T18:38:35-07:00' }));
  const result = {
    app: 'Duolingo (high-volume control)', page: 10, sort: 'mostRecent', max_rating: 4, count: 12, page_matching: 50,
    ...shapeReviews(huge), source: 'live App Store RSS (US)', feed_note: 'x'.repeat(400), match_note: 'x'.repeat(100),
  };
  assert.ok(16 * JSON.stringify(result).length < 120_000, String(JSON.stringify(result).length));
});

test('review feed: an empty page is fetched once more under a fresh cache key', async () => {
  const full = { feed: { entry: [entry(5, 'a'), entry(4, 'b')] } };
  const empty = { feed: { link: [] } };
  const urls = [];
  const seq = (...answers) => async (url) => { urls.push(url); return answers.shift(); };
  const args = { country: 'us', id: 1, sort: 'mostHelpful', page: 1 };

  assert.equal((await getReviewFeed(args, seq(empty, full))).length, 2, 'retry answer used');
  assert.equal(urls.length, 2);
  assert.match(urls[1], /\?cb=[0-9a-z]+$/);
  assert.ok(urls[1].startsWith(urls[0]));

  urls.length = 0;
  assert.equal((await getReviewFeed(args, seq(full))).length, 2);
  assert.equal(urls.length, 1, 'a full page is not refetched');

  urls.length = 0;
  assert.equal((await getReviewFeed(args, seq(empty, empty))).length, 0, 'really empty stays empty');
  urls.length = 0;
  const failing = async (url) => { urls.push(url); if (urls.length > 1) throw new Error('down'); return empty; };
  assert.deepEqual(await getReviewFeed(args, failing), [], 'a failed retry is not a new error');
});

/** Stub global fetch with feed bodies keyed by page, for the tool paths. */
function stubFeeds(pages) {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const page = Number(/page=(\d+)/.exec(String(url))?.[1]);
    return new Response(JSON.stringify(pages[page] ?? { feed: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { urls, restore: () => { globalThis.fetch = real; } };
}

test('reviews: empty and non-matching pages explain themselves', async () => {
  const full = { feed: { entry: Array.from({ length: 50 }, () => entry(5, 'great')) } };
  const stub = stubFeeds({ 2: full });
  try {
    const p1 = await getCompetitorReviews({ app: KIT, page: 1 });
    assert.equal(p1.count, 0);
    assert.match(p1.empty_note, /glitch/);
    assert.equal(stub.urls.length, 2, 'page 1 was retried');
    assert.match((await getCompetitorReviews({ app: KIT, page: 7 })).empty_note, /feed ends/);
    const none = await getCompetitorReviews({ app: KIT, page: 2, max_rating: 2 });
    assert.equal(none.page_reviews, 50);
    assert.equal(none.page_matching, 0);
    assert.match(none.match_note, /None of this page's 50/);
    assert.ok(!('empty_note' in none));
    const all = await getCompetitorReviews({ app: KIT, page: 2 });
    assert.equal(all.count, 12);
    assert.ok(!('match_note' in all) && !('empty_note' in all));
  } finally {
    stub.restore();
  }
});

// ------------------------------------------------------------------ trace

const chunk = (parts, finishReason) => ({ candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }] });
const fnCall = (name, args = {}) => ({ functionCall: { name, args } });
function fakeAI(rounds) {
  let i = 0;
  return { models: { async generateContentStream() { const c = rounds[i++]; return (async function* () { yield* c; })(); } } };
}

test('trace: short names, plurals, gaps and reach read cleanly', async () => {
  _setFetcherForTests(async () => fixture());
  _setLookupForTests(async () => ({ results: [] }));
  _resetCacheForTests();
  const stub = stubFeeds({ 2: { feed: { entry: Array.from({ length: 50 }, () => entry(5, 'great')) } } });
  try {
    const events = [];
    const ai = fakeAI([
      [chunk([
        fnCall('get_market_overview'),
        fnCall('get_version_ratings', { app: ATOMS }),
        fnCall('get_version_ratings', { app: KIT }),
        fnCall('get_rating_trend', { app: KIT, weeks: 8 }),
        fnCall('get_rating_trend', { app: HT, weeks: 2 }),
        fnCall('get_competitor_reviews', { app: 'Finch: Self-Care Pet' }),
        fnCall('get_competitor_reviews', { app: KIT, page: 2, max_rating: 2, sort: 'mostHelpful' }),
        fnCall('get_version_ratings', { app: '__proto__' }),
      ])],
      [chunk([{ text: 'Done.' }], 'STOP')],
    ]);
    await runAgentStream('reviews', [], 'hi', (e) => events.push(e), undefined, undefined, { ai });
    const lines = events.filter((e) => e.type === 'tool-end').map((e) => e.summary);
    const src = ' · gold snapshot, as of 2026-09-24';
    assert.deepEqual(lines, [
      `4 apps, 400 reviews (store ratings unavailable)${src}`,
      `Atoms: 4 versions, biggest drop 1.0.4 → 1.2.0 -1.34 (n=118→41), reviews to 2026-07-29${src}`,
      `HabitKit: 1 version, reviews to 2026-09-10${src}`,
      `HabitKit: not enough data for an 8-week trend, reviews to 2026-09-10${src}`,
      `Habit Tracker: last 2 wk 3.5 (n=20) vs prior 4.75 (n=40), -1.25${src}`,
      'Finch: 0 reviews, page 1 (feed came back empty) · live App Store RSS',
      'HabitKit: 0 reviews, page 2, ≤2★, most helpful (none matched on this page) · live App Store RSS',
      `error: app must be one of: ${Object.keys(TRACKED).join('; ')}`,
    ]);
  } finally {
    stub.restore();
    _setFetcherForTests(null);
    _setLookupForTests(null);
    _resetCacheForTests();
  }
});

// ------------------------------------------------------------------ cache

test('snapshot: one shared fetch, then the last good copy on failure', async () => {
  let calls = 0;
  _setFetcherForTests(async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return fixture(); });
  _resetCacheForTests();
  try {
    const [a, b] = await Promise.all([loadSnapshot(), loadSnapshot()]);
    assert.equal(calls, 1, 'concurrent callers share one fetch');
    assert.equal(a, b);
    await loadSnapshot();
    assert.equal(calls, 1, 'served from cache');

    _setFetcherForTests(async () => { throw new Error('GitHub is down'); });
    _resetCacheForTests({ keepCopy: true });
    const r = await getVersionRatings({ app: ATOMS });
    assert.equal(r.fetch_error, true);
    assert.equal(r.biggest_drop.delta, -1.34, 'last good copy still answers');

    _resetCacheForTests();
    assert.match((await getVersionRatings({ app: ATOMS })).error, /unavailable/, 'no copy at all: an error');
  } finally {
    _setFetcherForTests(null);
    _resetCacheForTests();
  }
});

test('snapshot: with no copy, a failure is remembered instead of refetched every call', async () => {
  let calls = 0;
  _setFetcherForTests(async () => { calls++; throw new Error('GitHub is down'); });
  _resetCacheForTests();
  try {
    for (let i = 0; i < 5; i++) assert.match((await getVersionRatings({ app: ATOMS })).error, /unavailable/);
    assert.equal(calls, 1);
  } finally {
    _setFetcherForTests(null);
    _resetCacheForTests();
  }
});

test('overview: the store lookup runs while the snapshot is still loading', async () => {
  let snapshotLoaded = false;
  let lookedUpEarly = null;
  _setFetcherForTests(() => new Promise((resolve) => setTimeout(() => { snapshotLoaded = true; resolve(fixture()); }, 30)));
  _setLookupForTests(async () => {
    lookedUpEarly = !snapshotLoaded;
    return { results: [{ trackId: TRACKED[HT].appId, averageUserRating: 4.8, userRatingCount: 10 }] };
  });
  _resetCacheForTests();
  try {
    const o = await getMarketOverview();
    assert.equal(lookedUpEarly, true, 'lookup started before the snapshot resolved');
    assert.equal(o.apps.find((a) => a.app === HT).store_rating, 4.8);
  } finally {
    _setFetcherForTests(null);
    _setLookupForTests(null);
    _resetCacheForTests();
  }
});

test('overview: a lookup with no results is a failure, not 15 minutes of no ratings', async () => {
  _setFetcherForTests(async () => fixture());
  _setLookupForTests(async () => ({ resultCount: 0, results: [] }));
  _resetCacheForTests();
  try {
    const o = await getMarketOverview();
    assert.equal(o.store_error, true);
    assert.match(o.store_note, /do not state/);
  } finally {
    _setFetcherForTests(null);
    _setLookupForTests(null);
    _resetCacheForTests();
  }
});

test('overview: a failed store lookup is flagged and remembered, and the snapshot still answers', async () => {
  let lookups = 0;
  _setFetcherForTests(async () => fixture());
  _setLookupForTests(async () => { lookups++; throw new Error('iTunes is down'); });
  _resetCacheForTests();
  try {
    for (let i = 0; i < 3; i++) {
      const o = await getMarketOverview();
      assert.equal(o.store_error, true);
      assert.ok(o.apps.every((a) => !('store_rating' in a)));
      assert.equal(o.as_of, '2026-09-24');
    }
    assert.equal(lookups, 1);
  } finally {
    _setFetcherForTests(null);
    _setLookupForTests(null);
    _resetCacheForTests();
  }
});

// ------------------------------------------------------------------ live

test('live: every snapshot app is tracked, and every tracked app is in the snapshot', async () => {
  const { snapshot } = await loadSnapshot();
  const names = snapshot.overview.map((o) => o.app_name).sort();
  assert.deepEqual(names, Object.keys(TRACKED).sort(), 'a rename in Databricks must update TRACKED');
});

test('live: every tracked id resolves on the US store', async () => {
  const ids = Object.values(TRACKED).map((t) => t.appId);
  const res = await fetch(`https://itunes.apple.com/lookup?id=${ids.join(',')}&country=us`);
  const found = new Set((await res.json()).results.map((r) => r.trackId));
  for (const [name, t] of Object.entries(TRACKED)) assert.ok(found.has(t.appId), name);
});

test('live: the Atoms 1.0.4 -> 1.2.0 drop is found', async () => {
  const r = await getVersionRatings({ app: 'Atoms' });
  const v = r.versions.find((x) => x.prev_version === '1.0.4' && x.version === '1.2.0');
  assert.ok(v && v.delta < -1, JSON.stringify(v));
  assert.ok(r.as_of && typeof r.stale === 'boolean');
});

test('live: competitor reviews come back for the habit apps in both sorts, without authors', async () => {
  for (const [name, t] of Object.entries(TRACKED)) {
    if (t.role !== 'habit') continue;
    for (const sort of ['mostRecent', 'mostHelpful']) {
      const r = await getCompetitorReviews({ app: name, sort });
      assert.ok(!r.error, `${name} ${sort}: ${r.error}`);
      assert.ok(r.count > 0, `${name} ${sort}: no reviews`);
      assert.ok(r.count <= 12);
      for (const review of r.reviews) {
        assert.deepEqual(Object.keys(review).sort(), ['date', 'rating', 'text', 'title', 'version'], name);
        assert.ok(review.text.length <= 300);
      }
    }
  }
  const critical = await getCompetitorReviews({ app: 'Productive', max_rating: 2 });
  assert.ok(critical.reviews.every((r) => r.rating <= 2));
});
