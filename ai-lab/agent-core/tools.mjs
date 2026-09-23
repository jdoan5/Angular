// Tools the Review Analyst agent can call. All hit Apple's public iTunes
// endpoints — no auth, no scraping — so the agent works with live App Store
// data while the only secret in the system stays the Gemini API key.

const DEVELOPER_ID = '6771974020'; // John Doan's App Store developer id

// Storefronts and sort orders the review tools will fetch. Checked here, not
// only in the schema enum: the model can send anything, and a public endpoint
// must not turn into a free proxy onto arbitrary iTunes URLs.
const COUNTRIES = ['us', 'gb', 'ca', 'au', 'vn'];
const SORTS = ['mostRecent', 'mostHelpful'];
const notMine = () => ({ error: "Not one of John's apps" });

const CATALOG_TTL_MS = 10 * 60_000;
// Without a deadline a stalled iTunes response hangs the whole agent turn
// until the platform kills the function.
const FETCH_TIMEOUT_MS = 8000;

async function getJSON(url) {
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
    if (err?.name === 'TimeoutError') throw new Error(`iTunes API timed out after ${FETCH_TIMEOUT_MS / 1000}s for ${url}`);
    throw err;
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
export async function getAppReviews({ appId, country, sort }) {
  // Lower-cased because models often send "US"; anything else outside the
  // list is refused before a request is made.
  country = typeof country === 'string' ? country.toLowerCase() : (country ?? 'us');
  sort ??= 'mostRecent';
  if (!COUNTRIES.includes(country)) return { error: `country must be one of: ${COUNTRIES.join(', ')}` };
  if (!SORTS.includes(sort)) return { error: `sort must be one of: ${SORTS.join(', ')}` };
  const id = await ownAppId(appId);
  if (id === null) return notMine();
  const data = await getJSON(
    `https://itunes.apple.com/${country}/rss/customerreviews/id=${id}/sortBy=${sort}/json`
  );
  let entries = data.feed?.entry ?? [];
  if (!Array.isArray(entries)) entries = [entries];
  // The first entry of this feed is sometimes the app itself, not a review.
  const reviews = entries
    .filter((e) => e?.['im:rating'])
    .slice(0, 30)
    .map((e) => ({
      rating: Number(e['im:rating']?.label ?? 0),
      title: e.title?.label ?? '',
      text: (e.content?.label ?? '').slice(0, 800),
      author: e.author?.name?.label ?? 'anonymous',
      appVersion: e['im:version']?.label ?? '',
      date: e.updated?.label ?? '',
    }));
  return { appId: id, country, sort, count: reviews.length, reviews };
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
    iosAppsNote: 'The authoritative list of published iOS apps (names, ratings, versions) comes from the list_my_apps tool — always prefer it over memory. appNotes below adds the "what it is and who it is for" that store metadata does not carry; it covers only some of the apps, so fall back to get_app_details for the rest.',
    // Every claim below is checked against the app's live store description.
    // The Concierge repeats these to visitors as fact, and an unchecked note
    // told them Streak Rings had an iPhone app and iCloud sync — the store copy
    // says watch-only and "No cloud". Re-check a note whenever its app ships
    // an update.
    appNotes: [
      { name: 'VietFix English', appId: 6796511772, note: 'English for Vietnamese speakers, explained in Vietnamese and built around 60 mistakes Vietnamese speakers really make, each showing the wrong sentence, the right one, and the Vietnamese habit that produced it. Also 13 sentence patterns compared with Vietnamese, 12 grammar topics, and 154 words with IPA and American-English audio; it only makes sense to someone who speaks Vietnamese' },
      { name: 'Homefolio: Home Inventory', appId: 6806631158, note: 'Private home inventory for insurance claims: photograph belongings room by room with values, brands, serial numbers, receipts and warranty dates, then export a claim-ready Personal Property Inventory PDF for an adjuster, with no page cap and no watermark. No account; it syncs only through your own iCloud across iPhone, iPad and Mac' },
      { name: 'Toehold: Sudoku Explained', appId: 6801322941, note: 'Sudoku whose help explains a technique instead of filling in a square: a live panel lists the techniques available on the board right now (what to look for, not where), and tapping one shows the cells that make it true with a one-sentence reason. Eleven named techniques, difficulty graded by the hardest technique a puzzle requires rather than by clue count, and every puzzle checked to have exactly one solution reachable by logic alone, never a guess' },
      { name: 'Price Trail: Drop Alerts', appId: 6792765641, note: 'Paste any product link (Amazon, Walmart, Best Buy, Target and most other stores) and it watches the price in the background, notifying you on any drop or when a target price is crossed. Compares the same product across stores side by side, charts price history, and gives an on-device "should you wait?" estimate with a confidence meter' },
      { name: 'Learn English: Pronunciation', appId: 6775637573, note: 'Ear training for the English sounds that change meaning: 14 sound contrasts and 70 minimal pairs (sheep/ship, think/sink, best/vest), where you hear a word and pick which one you heard. IPA plus a sound-it-out hint on all 361 words; audio is the built-in iOS speech voice rather than recordings, which is why it works 100% offline' },
      { name: 'Cosmic Cadets', appId: 6782706983, note: 'Space math adventure for kids 5-8, from counting to first multiplication, with difficulty that adapts to each child one skill at a time and a math-gated Parent Zone showing which skills are being mastered. No ads, no in-app purchases, no accounts, and nothing leaves the device' },
      { name: 'Streak Rings', appId: 6784836738, note: 'Habit tracker made only for Apple Watch, with no iPhone companion needed: tap a ring to complete a habit and see current and best streaks for each. No accounts and no cloud; every habit and streak stays on the watch' },
    ],
    highlights: [
      'Every app is free, with no ads, no tracking and no account; most also work fully offline, and some features need a connection, such as live scores and standings in Soccer 2026 or store prices in Price Trail',
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
    description: "Fetch recent public customer reviews for one of John's apps. Returns up to 30 reviews with rating, title, text, author, app version and date.",
    parameters: {
      type: 'OBJECT',
      properties: {
        appId: { type: 'NUMBER', description: 'The numeric App Store track id, from list_my_apps' },
        country: { type: 'STRING', description: 'Storefront: us, gb, ca, au or vn (default us)', enum: [...COUNTRIES] },
        sort: { type: 'STRING', description: 'mostRecent or mostHelpful', enum: ['mostRecent', 'mostHelpful'] },
      },
      required: ['appId'],
    },
  },
};
