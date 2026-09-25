// Review Radar tools for the App Review Analyst. John's own apps are too new
// to analyze (4 star ratings and no written reviews across 15 apps in
// September 2026), so the Analyst studies the market his habit tracker Streak
// Rings competes in instead, from two sources:
//   - the gold snapshot of John's Review Radar lakehouse (Databricks bronze /
//     silver / gold), which a GitHub Action commits daily. Aggregates only by
//     design: no review text, no author names.
//   - the live App Store review feed for the same six apps, for what reviewers
//     actually say.
// Every average, delta and window is computed here, not by the model: the
// model narrates numbers it was handed and never does arithmetic of its own.

import { getJSON, getReviewFeed, MAX_REVIEW_PAGE } from './tools.mjs';

export const SNAPSHOT_URL =
  'https://raw.githubusercontent.com/jdoan5/Angular/main/review-radar/public/gold_snapshot.json';

const SNAPSHOT_TTL_MS = 15 * 60_000;
// After a failed refresh, how long the last good copy is served before the
// next attempt: long enough that a GitHub outage does not add an 8-second
// timeout to every tool call of every turn.
const RETRY_AFTER_FAILURE_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
// Same threshold as the Review Radar dashboard's staleness banner: the Action
// runs daily, so a snapshot two days old means runs have been failing.
const STALE_DAYS = 2;
// Below this many reviews on either side, a trend is noise, not a finding.
const MIN_TREND_N = 20;
const MAX_TREND_WEEKS = 26;
const DEFAULT_TREND_WEEKS = 4;
// An app averaging this many reviews a week almost never has a week with none
// (Poisson: e^-5 is under 1%), so a missing week there is an ingestion pause,
// not silence — Duolingo lost two whole weeks that way in September 2026.
const GAP_SUSPECT_PER_WEEK = 5;
// 50 reviews a feed page. Every result stays in the contents of each later
// round, so 16 calls of the largest possible result must fit well inside
// agent.mjs's 150K-character cap next to the history: 20 reviews of 400
// characters measured 10.3K each, and 16 of them passed the cap.
const MAX_REVIEWS_RETURNED = 12;
const MAX_REVIEW_CHARS = 300;
const MAX_TITLE_CHARS = 80;
const SORTS = ['mostRecent', 'mostHelpful'];

/** The six apps the lakehouse ingests, keyed on its exact display names.
 *  radar.test.mjs fails if the snapshot names an app missing here, so a
 *  rename in Databricks cannot silently drop an app from the Analyst.
 *  `developer` is static because "Habit Tracker" by Inner Grow is easy to
 *  confuse with Streak Rings, whose watch app showed that name until 1.0.3. */
export const TRACKED = Object.freeze({
  'Productive - Habit Tracker': { short: 'Productive', appId: 983826477, role: 'habit', developer: 'Mosaic S.r.l.' },
  'Habit Tracker': { short: 'Habit Tracker', appId: 1438388363, role: 'habit', developer: 'Inner Grow Limited' },
  'Atoms - from Atomic Habits': { short: 'Atoms', appId: 6474421906, role: 'habit', developer: 'Atomic Development Inc.' },
  'Finch: Self-Care Pet': { short: 'Finch', appId: 1528595748, role: 'habit', developer: 'Finch Care Public Benefit Corporation' },
  'HabitKit': { short: 'HabitKit', appId: 6443918070, role: 'habit', developer: 'Sebastian Roehl' },
  // A volume control for the pipeline (hundreds of reviews a day), not a
  // habit app: it stays out of every habit-market comparison.
  'Duolingo (high-volume control)': { short: 'Duolingo', appId: 570060128, role: 'control', developer: 'Duolingo, Inc' },
});
const APP_NAMES = Object.keys(TRACKED);

/** Resolve a model-supplied app name: an exact own key of TRACKED, or a
 *  case-insensitive match on the full or short name. Object.hasOwn, not `in`,
 *  so "__proto__" or "constructor" can never resolve to something. */
export function resolveApp(app) {
  if (typeof app !== 'string') return null;
  if (Object.hasOwn(TRACKED, app)) return app;
  const want = app.trim().toLowerCase();
  return APP_NAMES.find((name) => name.toLowerCase() === want || TRACKED[name].short.toLowerCase() === want) ?? null;
}
const unknownApp = () => ({ error: `app must be one of: ${APP_NAMES.join('; ')}` });

// ---------------------------------------------------------------- snapshot

export function validateSnapshot(s) {
  const ok = s && typeof s === 'object'
    && typeof s.generated_at === 'string' && !Number.isNaN(Date.parse(s.generated_at))
    && Array.isArray(s.overview) && Array.isArray(s.rating_by_version) && Array.isArray(s.weekly_velocity);
  if (!ok) throw new Error('Review Radar snapshot is missing expected fields');
  return s;
}

let fetchJSON = getJSON;
let lookupJSON = getJSON;
let cached = null;   // { snapshot, fetchError, expires }
let failed = null;   // { error, until }: no copy to fall back on
let inflight = null;

async function refresh() {
  try {
    const snapshot = validateSnapshot(await fetchJSON(SNAPSHOT_URL));
    cached = { snapshot, fetchError: false, expires: Date.now() + SNAPSHOT_TTL_MS };
    failed = null;
  } catch (err) {
    // A last good copy beats no answer; the flag reaches the model and the
    // trace so a stale answer is never passed off as current.
    if (!cached) {
      // A cold instance has no copy: remember the failure for the same minute,
      // or every call of the turn waits out its own 8-second timeout.
      failed = { error: new Error(`Review Radar snapshot unavailable: ${err?.message ?? err}`), until: Date.now() + RETRY_AFTER_FAILURE_MS };
      throw failed.error;
    }
    cached = { snapshot: cached.snapshot, fetchError: true, expires: Date.now() + RETRY_AFTER_FAILURE_MS };
  }
  return cached;
}

/** The snapshot, cached, with one fetch shared by concurrent callers. */
export async function loadSnapshot() {
  if (cached && Date.now() < cached.expires) return cached;
  if (!cached && failed && Date.now() < failed.until) throw failed.error;
  inflight ??= refresh().finally(() => { inflight = null; });
  return inflight;
}

/** Test hooks: swap the fetchers and/or clear or expire the caches. */
export function _setFetcherForTests(fn) { fetchJSON = fn ?? getJSON; }
export function _setLookupForTests(fn) { lookupJSON = fn ?? getJSON; }
export function _resetCacheForTests({ keepCopy = false } = {}) {
  if (keepCopy && cached) cached = { ...cached, expires: 0 };
  else cached = null;
  failed = null;
  inflight = null;
  storeCache = null;
}

const day = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : null);
const round2 = (x) => Math.round(x * 100) / 100;

/** Provenance attached to every snapshot result. No snapshot-wide "newest
 *  review" here: it was Duolingo's date on every per-app result, which read
 *  as Atoms data reaching Sept 23 when Atoms stops at July 29. */
export function sourceOf(snapshot, fetchError = false, now = Date.now()) {
  const ageDays = Math.max(0, Math.floor((now - Date.parse(snapshot.generated_at)) / DAY_MS));
  return {
    source: 'Review Radar gold snapshot (Databricks)',
    as_of: day(snapshot.generated_at),
    age_days: ageDays,
    stale: ageDays >= STALE_DAYS,
    ...(fetchError ? { fetch_error: true } : {}),
    source_note: 'as_of is when the snapshot was exported, not how far ingestion reached: '
      + "an app's newest_review_at shows that. Ingestion pauses when the free Databricks "
      + 'workspace goes dormant, and a high-volume app can lose the reviews from a long pause.',
  };
}

const newestReviewOf = (snapshot, app) => snapshot.overview.find((o) => o.app_name === app)?.newest_review_at ?? null;

// ---------------------------------------------------------------- store ratings

let storeCache = null; // { byId, expires }; byId null after a failure

/** Store rating and count for all six apps in one batched lookup; null if it
 *  fails, and the overview is then returned without store fields. A failure
 *  is remembered for a minute so repeated calls do not each wait it out. */
async function storeRatings() {
  if (storeCache && Date.now() < storeCache.expires) return storeCache.byId;
  try {
    const ids = APP_NAMES.map((n) => TRACKED[n].appId).join(',');
    const data = await lookupJSON(`https://itunes.apple.com/lookup?id=${ids}&country=us`);
    const byId = new Map((data.results ?? []).map((r) => [r.trackId, r]));
    // A 200 with no results is a failure too, not 15 minutes of no ratings.
    if (!byId.size) throw new Error('lookup returned no results');
    storeCache = { byId, expires: Date.now() + SNAPSHOT_TTL_MS };
  } catch {
    storeCache = { byId: null, expires: Date.now() + RETRY_AFTER_FAILURE_MS };
  }
  return storeCache.byId;
}

// ---------------------------------------------------------------- pure analytics

export function marketOverview(snapshot, store = null) {
  const apps = snapshot.overview.map((o) => {
    const t = Object.hasOwn(TRACKED, o.app_name) ? TRACKED[o.app_name] : null;
    const s = t && store ? store.get(t.appId) : null;
    return {
      app: o.app_name,
      appId: t?.appId ?? null,
      developer: t?.developer ?? null,
      role: t?.role ?? 'untracked',
      reviews_collected: o.reviews_collected,
      written_review_avg: o.avg_rating,
      versions_seen: o.versions_seen,
      oldest_review_at: day(o.oldest_review_at),
      newest_review_at: day(o.newest_review_at),
      ...(s && typeof s.averageUserRating === 'number'
        ? { store_rating: round2(s.averageUserRating), store_rating_count: s.userRatingCount ?? null, store_name: s.trackName }
        : {}),
    };
  });
  // Habit apps first, the control last; within a role, by volume.
  apps.sort((a, b) => (a.role === 'control') - (b.role === 'control') || b.reviews_collected - a.reviews_collected);
  return {
    total_reviews: snapshot.totals?.reviews_collected ?? apps.reduce((s, a) => s + a.reviews_collected, 0),
    apps,
    ...(store ? {} : {
      store_error: true,
      store_note: 'Live App Store ratings are unavailable right now: do not state or compare a store rating.',
    }),
    note: 'written_review_avg is the mean star rating of the written reviews the lakehouse has collected; '
      + "store_rating is the App Store's star average over every rating, most of them left without a review. "
      + 'They are different populations, so a gap between them is expected, not an error. Duolingo is a '
      + 'high-volume control for the pipeline, not a habit app: leave it out of habit-app comparisons.',
  };
}

export function versionRatings(snapshot, app) {
  const rows = snapshot.rating_by_version
    .filter((r) => r.app_name === app)
    .sort((a, b) => String(a.first_review_at).localeCompare(String(b.first_review_at)));
  const versions = rows.map((r, i) => {
    const prev = rows[i - 1];
    return {
      version: r.app_version,
      avg_rating: r.avg_rating,
      n: r.n_reviews,
      first_review_at: day(r.first_review_at),
      prev_version: prev?.app_version ?? null,
      delta: prev ? round2(r.avg_rating - prev.avg_rating) : null,
      gap_days: prev ? Math.round((Date.parse(r.first_review_at) - Date.parse(prev.first_review_at)) / DAY_MS) : null,
    };
  });
  const pick = (better) => versions.filter((v) => v.delta !== null).reduce((best, v) => (best === null || better(v.delta, best.delta) ? v : best), null);
  const shape = (v) => v && { from: v.prev_version, to: v.version, delta: v.delta, n_from: rows.find((r) => r.app_version === v.prev_version)?.n_reviews ?? null, n_to: v.n, gap_days: v.gap_days };
  const drop = pick((a, b) => a < b);
  const rise = pick((a, b) => a > b);
  return {
    app,
    newest_review_at: day(newestReviewOf(snapshot, app)),
    versions,
    biggest_drop: drop && drop.delta < 0 ? shape(drop) : null,
    biggest_rise: rise && rise.delta > 0 ? shape(rise) : null,
    note: 'Only versions with 20 or more written reviews are listed, so consecutive rows can be '
      + 'several releases and a long time apart (see gap_days); a delta compares the listed versions, '
      + 'not necessarily back-to-back releases. The last row is the newest version with 20+ reviews, '
      + 'not necessarily the current release.',
  };
}

const mondayOf = (ms) => {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0; the gold weeks start on Monday
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY_MS;
};

/** Clamp a weeks argument; null when it is not a number at all. */
export function clampWeeks(weeks) {
  if (weeks == null) return DEFAULT_TREND_WEEKS;
  const w = Number(weeks);
  if (!Number.isFinite(w)) return null;
  return Math.min(MAX_TREND_WEEKS, Math.max(1, Math.round(w)));
}

export function ratingTrend(snapshot, app, weeks = DEFAULT_TREND_WEEKS) {
  const rows = snapshot.weekly_velocity
    .filter((r) => r.app_name === app && !r.is_partial_week)
    .map((r) => ({ week: Date.parse(r.week), n: r.n_reviews, avg: r.avg_rating }))
    .filter((r) => !Number.isNaN(r.week) && r.n > 0)
    .sort((a, b) => a.week - b.week);
  const newest = newestReviewOf(snapshot, app);
  // The latest week complete when the snapshot was exported — unless the
  // app's own reviews stop earlier. A week after the newest ingested review
  // may be a week with no reviews or a week ingestion never covered (on
  // 2026-09-24 Finch's reviews stopped at Sept 13 while the live feed had
  // ten more days), so windows end at the app's own data, never in a gap.
  const exportWeek = mondayOf(Date.parse(snapshot.generated_at)) - WEEK_MS;
  const newestMs = Date.parse(newest ?? '');
  const anchor = Number.isNaN(newestMs) ? exportWeek : Math.min(exportWeek, mondayOf(newestMs));

  const firstWeek = rows[0]?.week ?? Infinity;
  const windowAt = (endWeek) => {
    const from = endWeek - (weeks - 1) * WEEK_MS;
    const inside = rows.filter((r) => r.week >= from && r.week <= endWeek);
    const n = inside.reduce((s, r) => s + r.n, 0);
    // Weeks the data could have covered: none before the app's first week,
    // which prior_window_covered reports separately.
    const expected = Math.max(0, Math.floor((endWeek - Math.max(from, firstWeek)) / WEEK_MS) + 1);
    return {
      expected,
      stats: {
        from: day(new Date(from).toISOString()),
        to: day(new Date(endWeek + 6 * DAY_MS).toISOString()),
        avg: n ? round2(inside.reduce((s, r) => s + r.avg * r.n, 0) / n) : null,
        n,
        weeks_with_data: inside.length,
      },
      from,
    };
  };
  const recent = windowAt(anchor);
  const prior = windowAt(anchor - weeks * WEEK_MS);
  const r = recent.stats;
  const p = prior.stats;
  const priorCovered = rows.length > 0 && rows[0].week <= prior.from;
  const lowN = r.n < MIN_TREND_N || p.n < MIN_TREND_N;
  // From the rounded averages shown beside it, so the three numbers always
  // agree: from the unrounded ones, 4.04 vs 3.69 printed as +0.36.
  const delta = r.avg !== null && p.avg !== null ? round2(r.avg - p.avg) : null;
  // The app's usual volume, from its last 26 weeks with data up to the anchor
  // rather than only the two windows: if both fall in an ingestion hole,
  // the windows alone would say a 900-a-week app gets none.
  const recentRows = rows.filter((row) => row.week <= anchor && row.week > anchor - MAX_TREND_WEEKS * WEEK_MS);
  const perWeek = recentRows.length ? recentRows.reduce((sum, row) => sum + row.n, 0) / recentRows.length : 0;
  const gapSuspected = perWeek >= GAP_SUSPECT_PER_WEEK
    && (r.weeks_with_data < recent.expected || p.weeks_with_data < prior.expected);
  return {
    app,
    weeks,
    newest_review_at: day(newest),
    recent: r,
    prior: p,
    delta,
    low_n: lowN,
    prior_window_covered: priorCovered,
    ingestion_gap_suspected: gapSuspected,
    enough_data: delta !== null && !lowN && priorCovered && !gapSuspected,
    note: 'Weeks run Monday to Sunday. Partial weeks (the first week of an app\'s data, the week '
      + 'still in progress) are excluded. Averages are weighted by review count. A week with no row '
      + 'had no ingested reviews: for an app with a handful a week that is normal, but '
      + 'ingestion_gap_suspected means the app reviews too often for an empty week, so ingestion '
      + 'was paused. When enough_data is false, report that there is not enough data rather than '
      + 'a trend.',
  };
}

// ---------------------------------------------------------------- tool functions

async function withSnapshot(compute) {
  let snap;
  try {
    snap = await loadSnapshot();
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
  return { ...(await compute(snap.snapshot)), ...sourceOf(snap.snapshot, snap.fetchError) };
}

export async function getMarketOverview() {
  // Started first so the lookup and the snapshot load overlap.
  const store = storeRatings();
  return withSnapshot(async (s) => marketOverview(s, await store));
}

export async function getVersionRatings({ app } = {}) {
  const name = resolveApp(app);
  if (!name) return unknownApp();
  return withSnapshot((s) => versionRatings(s, name));
}

export async function getRatingTrend({ app, weeks } = {}) {
  const name = resolveApp(app);
  if (!name) return unknownApp();
  const w = clampWeeks(weeks);
  if (w === null) return { error: `weeks must be a number from 1 to ${MAX_TREND_WEEKS}` };
  const result = await withSnapshot((s) => ratingTrend(s, name, w));
  // Say so when the window was changed, or "a 52-week trend" gets reported
  // over 26 weeks of data.
  const asked = Number(weeks);
  if (weeks != null && asked !== w && !result.error) {
    const how = asked < 1 || asked > MAX_TREND_WEEKS ? `Clamped to the ${MAX_TREND_WEEKS === w ? 'maximum' : 'minimum'} of` : 'Rounded to';
    return { ...result, requested_weeks: asked, weeks_note: `${how} ${w} week${w === 1 ? '' : 's'} (the range is 1 to ${MAX_TREND_WEEKS}).` };
  }
  return result;
}

// By code point, so an emoji at the cut is never split into half a surrogate.
const clip = (text, max) => {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
};
// Feed dates are Pacific time ("2026-09-17T18:38:35-07:00") and the snapshot's
// are UTC; the same review read as Sept 17 live and Sept 18 in Review Radar.
const utcDay = (label) => {
  const ms = Date.parse(label ?? '');
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
};

/** Shape feed entries into results: filter by rating, keep the first
 *  MAX_REVIEWS_RETURNED, clip. Pure, so the size bound can be tested. */
export function shapeReviews(entries, maxRating = 5) {
  const matching = entries
    .map((e) => ({
      rating: Number(e['im:rating']?.label ?? 0),
      title: clip(e.title?.label, MAX_TITLE_CHARS),
      text: clip(e.content?.label, MAX_REVIEW_CHARS),
      version: e['im:version']?.label ?? '',
      date: utcDay(e.updated?.label),
    }))
    .filter((r) => r.rating >= 1 && r.rating <= maxRating);
  return { matching: matching.length, reviews: matching.slice(0, MAX_REVIEWS_RETURNED) };
}

/** Live written reviews for a tracked app. No author field: a reviewer's
 *  name is their personal data, and the Review Radar snapshot carries none. */
export async function getCompetitorReviews({ app, page, max_rating, sort } = {}) {
  const name = resolveApp(app);
  if (!name) return unknownApp();
  page = page == null ? 1 : Number(page);
  if (!Number.isInteger(page) || page < 1 || page > MAX_REVIEW_PAGE) {
    return { error: `page must be a whole number from 1 to ${MAX_REVIEW_PAGE}` };
  }
  const maxRating = max_rating == null ? 5 : Number(max_rating);
  if (!Number.isInteger(maxRating) || maxRating < 1 || maxRating > 5) {
    return { error: 'max_rating must be a whole number from 1 to 5' };
  }
  sort ??= 'mostRecent';
  if (!SORTS.includes(sort)) return { error: `sort must be one of: ${SORTS.join(', ')}` };
  const entries = await getReviewFeed({ country: 'us', id: TRACKED[name].appId, sort, page });
  const { matching, reviews } = shapeReviews(entries, maxRating);
  return {
    app: name,
    page,
    sort,
    ...(maxRating < 5 ? { max_rating: maxRating } : {}),
    count: reviews.length,
    // The page's size and how many on it matched the rating filter: the
    // rest are skipped, and page 2 starts at the page's 51st review, not
    // after the last one shown.
    page_reviews: entries.length,
    page_matching: matching,
    reviews,
    ...(entries.length === 0 ? { empty_note: page === 1
      ? 'This feed page came back empty even after a retry. Every tracked app has reviews, so this '
        + 'is a glitch in Apple\'s feed: try the other sort before saying there are none.'
      : 'This page is empty, most likely because the app\'s feed ends before it (apps with fewer '
        + 'reviews run out before page 10).' } : {}),
    ...(entries.length > 0 && matching === 0
      ? { match_note: `None of this page's ${entries.length} reviews are at or below ${maxRating} stars; other pages may have some.` }
      : {}),
    source: 'live App Store RSS (US)',
    feed_note: (sort === 'mostHelpful'
      ? 'mostHelpful returns the most-voted reviews, which can be years old: check each date and '
        + 'version before calling a complaint current.'
      : 'mostRecent covers only the newest 500 reviews (10 pages of 50), so it samples recent '
        + 'opinion, not an app\'s whole history.')
      + ` Each call returns the first ${MAX_REVIEWS_RETURNED} matching reviews of one 50-review page.`,
  };
}

// ---------------------------------------------------------------- registry

const APP_PARAM = { type: 'STRING', description: 'Tracked app, exactly as listed', enum: [...APP_NAMES] };

export const radarTools = {
  // Zero-arg: parameters omitted entirely (see the note above toolRegistry).
  get_market_overview: {
    fn: getMarketOverview,
    description: "Review Radar market overview for the six apps John's lakehouse tracks (five habit apps Streak Rings competes with, plus Duolingo as a high-volume control): reviews collected, written-review average, versions seen, newest review, and the live App Store rating. Includes the snapshot's as-of date and staleness.",
  },
  get_version_ratings: {
    fn: getVersionRatings,
    description: "Average written-review rating per app version (versions with 20+ reviews) for one tracked app, with the change from the previous listed version, review counts, days between them, and the biggest drop and rise. All arithmetic is done for you.",
    parameters: { type: 'OBJECT', properties: { app: APP_PARAM }, required: ['app'] },
  },
  get_rating_trend: {
    fn: getRatingTrend,
    description: "Compare one tracked app's written-review rating over its most recent N complete weeks with the N weeks before (review-count weighted). Returns both windows with dates and counts, the delta, and enough_data; when enough_data is false there is no trend to report.",
    parameters: {
      type: 'OBJECT',
      properties: {
        app: APP_PARAM,
        weeks: { type: 'INTEGER', description: `Window length in weeks, 1 to ${MAX_TREND_WEEKS} (default ${DEFAULT_TREND_WEEKS})` },
      },
      required: ['app'],
    },
  },
  get_competitor_reviews: {
    fn: getCompetitorReviews,
    description: `Fetch live US App Store written reviews for one tracked app: the first ${MAX_REVIEWS_RETURNED} matching reviews of one 50-review feed page (rating, title, text, version, date; no reviewer names). Use max_rating to read only critical reviews, e.g. 2 for 1- and 2-star.`,
    parameters: {
      type: 'OBJECT',
      properties: {
        app: APP_PARAM,
        page: { type: 'INTEGER', description: `Feed page of 50 reviews, 1 to ${MAX_REVIEW_PAGE} (default 1)` },
        max_rating: { type: 'INTEGER', description: 'Only reviews at or below this many stars, 1 to 5 (default 5: all)' },
        sort: { type: 'STRING', description: 'mostRecent (default) or mostHelpful', enum: [...SORTS] },
      },
      required: ['app'],
    },
  },
};
