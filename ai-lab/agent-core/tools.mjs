// Tools the Review Analyst agent can call. All hit Apple's public iTunes
// endpoints — no auth, no scraping — so the agent works with live App Store
// data while the only secret in the system stays the Gemini API key.

const DEVELOPER_ID = '6771974020'; // John Doan's App Store developer id

// Storefronts and sort orders the review tools will fetch. Checked here, not
// only in the schema enum: the model can send anything, and a public endpoint
// must not turn into a free proxy onto arbitrary iTunes URLs.
const COUNTRIES = ['us', 'gb', 'ca', 'au', 'vn'];
const SORTS = ['mostRecent', 'mostHelpful'];
// The review feed ends at page 10: page=11 answered HTTP 400 when checked on
// 2026-09-24 and 2026-09-25. Apps with fewer reviews run out sooner (HabitKit
// after page 5), and past that a page is simply empty.
export const MAX_REVIEW_PAGE = 10;
const notMine = () => ({ error: "Not one of John's apps" });

const CATALOG_TTL_MS = 10 * 60_000;
// Without a deadline a stalled iTunes response hangs the whole agent turn
// until the platform kills the function.
const FETCH_TIMEOUT_MS = 8000;

// Exported for radar.mjs, which reads the Review Radar snapshot under the same
// deadline. The import runs one way only: tools.mjs must never import
// radar.mjs, for the same module-cycle reason agent.mjs gives for game.mjs.
export async function getJSON(url) {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    // Awaited inside the try: the same signal aborts a body that stalls after
    // the headers arrive, and that should read as a timeout with its URL too.
    return await res.json();
  } catch (err) {
    // Not "iTunes API": radar.mjs fetches GitHub through this too, and tool
    // errors reach the visitor's trace verbatim. The URL names the host.
    if (err?.name === 'TimeoutError') throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s for ${url}`);
    throw err;
  }
}

// ------------------------------------------------------------------ review feed

const reviewEntries = (data) => {
  let entries = data?.feed?.entry ?? [];
  if (!Array.isArray(entries)) entries = [entries];
  // The first entry of this feed is sometimes the app itself, not a review.
  return entries.filter((e) => e?.['im:rating']);
};

/** One page of an App Store review feed, as review entries (shared with
 *  radar.mjs). Apple's CDN caches each exact URL, and it has served a cached
 *  empty feed for one URL while every other URL for the same page was full:
 *  HabitKit's page=1 mostHelpful for about 15 minutes on 2026-09-25 (x-cache
 *  TCP_MEM_HIT), Duolingo's page-less form on 2026-09-24. An empty body looks
 *  exactly like an app with no reviews, so an empty page is fetched once more
 *  under a cache key the CDN has never seen, which returned the same review
 *  ids when checked. The key is unique per request: a per-minute key once
 *  cached an empty answer of its own and served it to every retry that minute
 *  (random keys came back empty 2 times in 40). A feed that really is empty
 *  (all of John's apps today) costs one extra request. */
export async function getReviewFeed({ country, id, sort, page }, fetchJSON = getJSON) {
  const url = `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${id}/sortBy=${sort}/json`;
  const entries = reviewEntries(await fetchJSON(url));
  if (entries.length) return entries;
  try {
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return reviewEntries(await fetchJSON(`${url}?cb=${key}`));
  } catch {
    return entries; // the first answer stands; a failed retry is not a new error
  }
}

// ------------------------------------------------------------------ catalog
//
// One developer lookup backs both listMyApps and the "is this John's app?"
// gate. It runs on most Review/Concierge turns and backs the Guess My App
// catalog, so it is cached, and concurrent callers share one in-flight fetch
// rather than each spending quota on the same request. Failures are not
// cached: the next call simply retries.

let catalogCache = null;    // { at, results, ids }
let catalogInFlight = null;

// How long an expired catalog may stand in for a failed refetch. Membership
// only changes when John ships an app, but listMyApps also reports ratings
// and versions, so a long outage should surface rather than serve old numbers.
const CATALOG_STALE_MAX_MS = 60 * 60_000;

async function catalogLookup() {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache;
  catalogInFlight ??= getJSON(
    `https://itunes.apple.com/lookup?id=${DEVELOPER_ID}&entity=software&country=us&limit=200`
  )
    .then((data) => {
      const results = (data.results ?? []).filter((r) => r.wrapperType === 'software');
      // An empty lookup is an iTunes hiccup, not a real catalog. Handing it on
      // made the gate answer "Not one of John's apps" for John's own apps, and
      // the agents repeated that to visitors as fact.
      if (!results.length) throw new Error('App Store catalog lookup came back empty');
      catalogCache = { at: Date.now(), results, ids: new Set(results.map((r) => r.trackId)) };
      return catalogCache;
    })
    .catch((err) => {
      // A 503 or timeout right after the TTL lapses shouldn't break details
      // and reviews for apps we listed minutes ago. `at` is left alone, so the
      // next call tries the refetch again.
      if (catalogCache && Date.now() - catalogCache.at < CATALOG_STALE_MAX_MS) return catalogCache;
      throw err;
    })
    .finally(() => { catalogInFlight = null; });
  return catalogInFlight;
}

/** The appId as a number if it is one of John's apps, else null. Number()
 *  because the model sends ids as numbers or strings interchangeably. */
async function ownAppId(appId) {
  const id = Number(appId);
  if (!Number.isSafeInteger(id)) return null;
  const { ids } = await catalogLookup();
  return ids.has(id) ? id : null;
}

/** All published apps for the developer account. */
export async function listMyApps() {
  const { results } = await catalogLookup();
  // Mapped fresh per call so a caller mutating its copy can't corrupt the cache.
  const apps = results.map((r) => ({
    appId: r.trackId,
    name: r.trackName,
    genre: r.primaryGenreName,
    averageRating: r.averageUserRating ?? null,
    ratingCount: r.userRatingCount ?? 0,
    version: r.version,
    released: r.releaseDate,
    lastUpdated: r.currentVersionReleaseDate,
    url: r.trackViewUrl,
  }));
  return { developerId: DEVELOPER_ID, count: apps.length, apps };
}

/** Store metadata for one app. */
export async function getAppDetails({ appId }) {
  const id = await ownAppId(appId);
  if (id === null) return notMine();
  const data = await getJSON(`https://itunes.apple.com/lookup?id=${id}&country=us`);
  const r = (data.results ?? [])[0];
  if (!r) return { error: `No app found for id ${id}` };
  return {
    appId: r.trackId,
    name: r.trackName,
    description: (r.description ?? '').slice(0, 1200),
    genre: r.primaryGenreName,
    genres: Array.isArray(r.genres) ? r.genres : [],
    price: r.price ?? null,
    formattedPrice: r.formattedPrice ?? null,
    contentRating: r.trackContentRating,
    averageRating: r.averageUserRating ?? null,
    ratingCount: r.userRatingCount ?? 0,
    currentVersionRating: r.averageUserRatingForCurrentVersion ?? null,
    currentVersionRatingCount: r.userRatingCountForCurrentVersion ?? 0,
    version: r.version,
    releaseNotes: (r.releaseNotes ?? '').slice(0, 600),
    released: r.releaseDate,
    lastUpdated: r.currentVersionReleaseDate,
    sizeMB: r.fileSizeBytes ? +(r.fileSizeBytes / 1e6).toFixed(1) : null,
    minimumOsVersion: r.minimumOsVersion,
    url: r.trackViewUrl,
  };
}

/** Recent customer reviews for one app (public RSS feed). */
export async function getAppReviews({ appId, country, sort, page }) {
  // Lower-cased because models often send "US"; anything else outside the
  // list is refused before a request is made.
  country = typeof country === 'string' ? country.toLowerCase() : (country ?? 'us');
  sort ??= 'mostRecent';
  // Number() because the model sends numbers as strings too, like appId. The
  // integer check is also what keeps anything but a page number out of the URL.
  page = page == null ? 1 : Number(page);
  if (!COUNTRIES.includes(country)) return { error: `country must be one of: ${COUNTRIES.join(', ')}` };
  if (!SORTS.includes(sort)) return { error: `sort must be one of: ${SORTS.join(', ')}` };
  if (!Number.isInteger(page) || page < 1 || page > MAX_REVIEW_PAGE) {
    return { error: `page must be a whole number from 1 to ${MAX_REVIEW_PAGE}` };
  }
  const id = await ownAppId(appId);
  if (id === null) return notMine();
  const entries = await getReviewFeed({ country, id, sort, page });
  // A feed page holds 50; 30 bounds what every later round re-sends (a full
  // page of mostHelpful reviews measured 46K chars against agent.mjs's 150K
  // turn budget), at the cost of entries 31-50 of each page.
  // No author field: a reviewer's name is their personal data, the Review
  // Radar snapshot carries none by design, and the Analyst attributes quotes
  // by rating.
  const reviews = entries
    .slice(0, 30)
    .map((e) => ({
      rating: Number(e['im:rating']?.label ?? 0),
      title: e.title?.label ?? '',
      text: (e.content?.label ?? '').slice(0, 800),
      appVersion: e['im:version']?.label ?? '',
      date: e.updated?.label ?? '',
    }));
  return { appId: id, country, sort, page, count: reviews.length, reviews };
}

/** Curated, static facts about John and the portfolio — the Concierge's
 *  grounding for everything the App Store lookup can't tell it. */
export function getDeveloperProfile() {
  return {
    name: 'John Doan',
    role: 'Independent app developer',
    portfolio: 'https://jdoan5.github.io',
    appStoreDeveloperPage: 'https://apps.apple.com/us/developer/john-doan/id6771974020',
    supportEmail: 'john@johnvdoan.com',
    iosStack: 'SwiftUI, SwiftData (some apps add CloudKit sync, Swift Charts, WatchKit)',
    webStack: 'Angular 22 with signals, SCSS, deployed on Vercel',
    alsoLearning: 'Java Spring Boot (REST APIs, OAuth2), Terraform',
    webApps: [
      { name: 'Personal Budget Planner', kind: 'Angular web app', note: 'income and expense tracking with per-category monthly budgets and a donut-chart dashboard, runs fully in the browser (localStorage)' },
      { name: 'Hangman Encyclopedia', kind: 'Angular web app', note: 'hangman plus a collectible encyclopedia of fact-checked entries' },
      { name: 'Review Radar', kind: 'Angular web app over a Databricks lakehouse', note: 'dashboard of App Store review aggregates, fed by a bronze/silver/gold medallion pipeline in Databricks; a GitHub Action refreshes the committed gold snapshot daily. Aggregates only by design — no review text, no author names. Charts are hand-rolled SVG, no chart library' },
      { name: "John's AI Lab", kind: 'Angular + Gemini agents', note: 'this very app — agents with live App Store tools on Google Gemini. The deployed lab runs on Vertex AI with an express key; the same code also supports a plain AI Studio key, or keyless Vertex through Application Default Credentials (Workload Identity when it runs on GKE), selected by environment variable with no code change' },
    ],
    iosAppsNote: 'The authoritative list of published iOS apps (names, ratings, versions) comes from the list_my_apps tool — always prefer it over memory. appNotes below adds the "what it is and who it is for" that store metadata does not carry. It was written against the apps published in September 2026, so an app released later may be missing: fall back to get_app_details for any app it does not list.',
    // Every claim below is checked against the app's live store description.
    // The Concierge repeats these to visitors as fact, and an unchecked note
    // told them Streak Rings had an iPhone app and iCloud sync — the store copy
    // says watch-only and "No cloud". Re-check a note whenever its app ships
    // an update. The description is the source, not the release notes: on
    // 2026-09-24 seven apps' release notes announced features (reminders, iPad
    // layouts, resume attachments, iCloud sync) that their descriptions do not
    // mention, and Tabwise's notes say it syncs through iCloud while its
    // description says records never leave the device. A note states neither
    // side of that. All 15 last checked against their descriptions 2026-09-24.
    appNotes: [
      { name: 'VietFix English', appId: 6796511772, note: 'English for Vietnamese speakers, explained in Vietnamese and built around 60 mistakes Vietnamese speakers really make, each showing the wrong sentence, the right one, and the Vietnamese habit that produced it. Also 13 sentence patterns compared with Vietnamese, 12 grammar topics, and 154 words with IPA and American-English audio; it only makes sense to someone who speaks Vietnamese' },
      { name: 'Homefolio: Home Inventory', appId: 6806631158, note: 'Private home inventory for insurance claims: photograph belongings room by room with values, brands, serial numbers, receipts and warranty dates, then export a claim-ready Personal Property Inventory PDF for an adjuster, with no page cap and no watermark. No account; it syncs only through your own iCloud across iPhone, iPad and Mac' },
      { name: 'Toehold: Sudoku Explained', appId: 6801322941, note: 'Sudoku whose help explains a technique instead of filling in a square: a live panel lists the techniques available on the board right now (what to look for, not where), and tapping one shows the cells that make it true with a one-sentence reason. Eleven named techniques, difficulty graded by the hardest technique a puzzle requires rather than by clue count, and every puzzle checked to have exactly one solution reachable by logic alone, never a guess' },
      { name: 'Price Trail: Drop Alerts', appId: 6792765641, note: 'Paste any product link (Amazon, Walmart, Best Buy, Target and most other stores) and it watches the price in the background, notifying you on any drop or when a target price is crossed. Compares the same product across stores side by side, charts price history, and gives an on-device "should you wait?" estimate with a confidence meter' },
      { name: 'Learn English: Pronunciation', appId: 6775637573, note: 'Ear training for adult learners, aimed at the English sounds that change meaning: 14 sound contrasts and 70 minimal pairs (sheep/ship, think/sink, best/vest), where you hear a word and pick which one you heard. IPA plus a sound-it-out hint on all 361 words; audio is the built-in iOS speech voice rather than recordings, which is why it works 100% offline' },
      { name: 'Cosmic Cadets', appId: 6782706983, note: 'Space math adventure for kids 5-8, from counting to first multiplication, with difficulty that adapts to each child one skill at a time and a math-gated Parent Zone showing which skills are being mastered. No ads, no in-app purchases, no accounts, and nothing leaves the device' },
      { name: 'Streak Rings', appId: 6784836738, note: 'Habit tracker made only for Apple Watch, with no iPhone companion needed: tap a ring to complete a habit and see current and best streaks for each. No accounts and no cloud; every habit and streak stays on the watch. Its store description still calls it Habit Tracker; it is not the Habit Tracker app by Inner Grow' },
      { name: 'US Citizenship Questions Prep', appId: 6778971932, note: 'Practice for the 2025 U.S. citizenship civics test with all 128 official USCIS questions: a 20-question multiple-choice practice test that ends early once the result is decided (12 correct passes), fill-in-the-blank with forgiving grading for answers typed the way you would say them, flags on every answer that changes with elections, and one toggle for the official 65/20 list (applicants 65 or older with 20+ years as permanent residents; 10 asked, 6 to pass). Works offline with no account; its description calls it Civics Test 2025, an independent study tool not affiliated with USCIS' },
      { name: 'Job Trail Applications', appId: 6776927520, note: 'A private job-application tracker: log each application with company, role, location, date applied and posting link, add recruiter notes, salary ranges and next steps, mark it Applied, Interviewing, Offer, Rejected or Withdrawn, and filter to just your active interviews or open offers. No account and no connection needed; everything stays on your device' },
      // The tournament ended 2026-07-19. The description still sells live
      // scores, and says nothing about whether final results stay in the app.
      { name: 'Soccer 2026: Live Scores', appId: 6776318136, note: 'An independent, unofficial companion built for the 2026 World Cup, which ended July 19, 2026, so recommend it only as a record of that tournament: the 104-match schedule in local time, the 12 groups, team pages and the Round-of-32-to-Final bracket are built in and open offline. Live scores and standings came from a third-party data service during the tournament, and the store page does not say whether final results remain in the app, so do not promise them' },
      { name: 'Tabwise: Bills & Invoices', appId: 6782749406, note: 'A private ledger for the money going in and out of your life or small business, on iPhone, iPad and Mac: bills paid and invoices sent, how each was paid (online, check, card, cash or bank transfer) with check numbers, Pending, Partially Paid, Paid or Overdue status with optional due-date reminders, repeating entries, attached receipts, tax-deductible flags and CSV export for an accountant. No account, works offline, and it never connects to a bank or moves money; its description calls it Invoice Tracker' },
      { name: '503020: Budget Coach', appId: 6780275076, note: 'A monthly budget check against the 50/30/20 guideline (needs, wants, savings) that shows whether you are under or over budget and by exactly how much, with a Coach me button for 3-5 tips from your actual numbers, generated on the device by Apple Intelligence or rule-based where Apple Intelligence is unavailable, plus monthly snapshots to follow your savings rate. No account and no network connection, so the budget never leaves the device; the tips are general education, not financial advice' },
      { name: 'Family Medical Refill', appId: 6772649719, note: 'A caregiver organizer for a whole family\'s medications and appointments: refill dates sorted by urgency (overdue, refill now, this week, planned), doctor visits, lab work and insurance calls in one view across everyone, and Apple Intelligence that drafts refill requests and reschedule notes to doctors, pharmacies and insurers on the device, with templates when it is not enabled. No account, no cloud and works offline; it is an organizer, not medical advice' },
      { name: 'Three in a Row Duel', appId: 6772803398, note: 'Tic-tac-toe with a named-player leaderboard (wins, losses, draws and win rate per person) for settling the household champion, played pass-and-play on one device or against the computer at Easy (random moves, suited to younger kids), Medium (blocks your wins and takes its own) or Unbeatable (full minimax search: you can draw but cannot win). Every match is recorded; its description calls it Tic Tac Toe' },
      { name: 'LCD Classic Snake', appId: 6773937059, note: 'Classic Snake with a green-on-black retro LCD look: swipe to steer, three difficulties worth 10, 20 or 40 points per food, and a top-10 leaderboard per difficulty for named players. Auto-pauses when you switch apps or lock the phone; no ads and no account' },
    ],
    highlights: [
      // Soccer 2026's live scores left this line when the World Cup ended.
      'Every app is free, with no ads, no tracking and no account; most also work fully offline, and some features need a connection, such as the store-price checks in Price Trail',
      "The catalog spans language learning, US citizenship test prep, kids' math, personal finance, home inventory, health, productivity, shopping, sports and games",
      'The newest releases are Homefolio (home inventory) and VietFix English (English for Vietnamese speakers) — check list_my_apps for exact dates',
    ],
  };
}

/** Registry the agent loop dispatches on. NOTE: zero-arg tools must omit
 *  `parameters` entirely — Vertex rejects an OBJECT schema with no properties. */
export const toolRegistry = {
  get_developer_profile: {
    fn: getDeveloperProfile,
    description: "Static profile of John Doan: tech stacks, web apps, portfolio and support links, and highlights. Use for questions about John, his skills, or non-App-Store projects.",
  },
  list_my_apps: { fn: listMyApps, description: 'List all of John Doan\'s published App Store apps with ids, ratings and versions.' },
  get_app_details: {
    fn: getAppDetails,
    description: "Get full App Store metadata for one of John's apps: description, ratings (lifetime and current version), version, release notes, size.",
    parameters: {
      type: 'OBJECT',
      properties: { appId: { type: 'NUMBER', description: 'The numeric App Store track id, from list_my_apps' } },
      required: ['appId'],
    },
  },
  get_app_reviews: {
    fn: getAppReviews,
    description: "Fetch recent public customer reviews for one of John's apps. Returns up to 30 reviews from one page of the feed, with rating, title, text, app version and date.",
    parameters: {
      type: 'OBJECT',
      properties: {
        appId: { type: 'NUMBER', description: 'The numeric App Store track id, from list_my_apps' },
        country: { type: 'STRING', description: 'Storefront: us, gb, ca, au or vn (default us)', enum: [...COUNTRIES] },
        sort: { type: 'STRING', description: 'mostRecent or mostHelpful', enum: ['mostRecent', 'mostHelpful'] },
        // The range lives in the description, not minimum/maximum: those are
        // untested against Vertex, a rejected schema would fail every Analyst
        // turn, and getAppReviews refuses out-of-range pages either way.
        page: { type: 'INTEGER', description: 'Feed page, 1 to 10 (default 1). Ask for the next page only after a page that returned 30 reviews' },
      },
      required: ['appId'],
    },
  },
};
