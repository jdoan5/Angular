// Tools the Review Analyst agent can call. All hit Apple's public iTunes
// endpoints — no auth, no scraping — so the agent works with live App Store
// data while the only secret in the system stays the Gemini API key.

const DEVELOPER_ID = '6771974020'; // John Doan's App Store developer id

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** All published apps for the developer account. */
export async function listMyApps() {
  const data = await getJSON(
    `https://itunes.apple.com/lookup?id=${DEVELOPER_ID}&entity=software&country=us&limit=200`
  );
  const apps = (data.results ?? [])
    .filter((r) => r.wrapperType === 'software')
    .map((r) => ({
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
  const data = await getJSON(
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=us`
  );
  const r = (data.results ?? [])[0];
  if (!r) return { error: `No app found for id ${appId}` };
  return {
    appId: r.trackId,
    name: r.trackName,
    description: (r.description ?? '').slice(0, 1200),
    genre: r.primaryGenreName,
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
export async function getAppReviews({ appId, country = 'us', sort = 'mostRecent' }) {
  const data = await getJSON(
    `https://itunes.apple.com/${encodeURIComponent(country)}/rss/customerreviews/id=${encodeURIComponent(appId)}/sortBy=${encodeURIComponent(sort)}/json`
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
  return { appId, country, sort, count: reviews.length, reviews };
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
      { name: "John's AI Lab", kind: 'Angular + Gemini agents', note: 'this very app — agents with live App Store tools, on Google Gemini via an AI Studio key by default (Vertex express mode is an opt-in switch)' },
    ],
    iosAppsNote: 'The authoritative list of published iOS apps (names, ratings, versions) comes from the list_my_apps tool — always prefer it over memory. appNotes below adds the "what it is and who it is for" that store metadata does not carry; it covers only some of the apps, so fall back to get_app_details for the rest.',
    appNotes: [
      { name: 'VietFix English', appId: 6796511772, note: 'English for Vietnamese speakers, explained in Vietnamese. Built around 60 mistakes Vietnamese learners actually make — each showing the wrong sentence, the right one, and the Vietnamese habit that caused it. Plus 13 Vietnamese-to-English sentence patterns, 12 grammar topics, and 112 words with IPA and audio. Only makes sense to someone who speaks Vietnamese, which is the point' },
      { name: 'Homefolio: Home Inventory', appId: 6806631158, note: 'Private home inventory for insurance. Photograph your belongings room by room with values, brands, serial numbers, receipts and warranty dates, then export a claim-ready Personal Property Inventory PDF for an adjuster — no page cap, no watermark, no account' },
      { name: 'Toehold: Sudoku Explained', appId: 6801322941, note: 'Sudoku that teaches instead of solving for you. A live panel inventories which techniques are available on the board right now and explains why one works, without saying where to place the digit. Eleven named techniques, and difficulty graded by the hardest technique a puzzle actually requires rather than by clue count. Every puzzle is verified to have one solution reachable by logic alone — never a guess' },
      { name: 'Price Trail: Drop Alerts', appId: 6792765641, note: 'Paste any product link (Amazon, Walmart, Best Buy, Target and most other stores) and it watches the price in the background, notifying you on any drop or when a target price is crossed. Compares the same product across stores side by side, charts price history, and gives an on-device "should you wait?" estimate with a confidence meter' },
      { name: 'Learn English: Pronunciation', appId: 6775637573, note: 'Trains the listening skill most English apps skip: 14 sound contrasts and 70 minimal pairs (sheep/ship, think/sink, best/vest) where the sound changes the meaning. Hear a word, pick which one you heard. IPA plus a sound-it-out hint on all 361 words' },
      { name: 'Cosmic Cadets', appId: 6782706983, note: 'Space math adventure for kids 5-8, adaptive difficulty, no ads or purchases' },
      { name: 'Streak Rings', appId: 6784836738, note: 'Habit tracker with an Apple Watch app and iCloud sync' },
    ],
    highlights: [
      'All apps are free and ad-free with no tracking; several are fully offline and need no account',
      'Range is deliberate: language learning, personal finance, health, productivity, shopping, and games',
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
    description: 'Get full App Store metadata for one app: description, ratings (lifetime and current version), version, release notes, size.',
    parameters: {
      type: 'OBJECT',
      properties: { appId: { type: 'NUMBER', description: 'The numeric App Store track id, from list_my_apps' } },
      required: ['appId'],
    },
  },
  get_app_reviews: {
    fn: getAppReviews,
    description: 'Fetch recent public customer reviews for one app. Returns up to 30 reviews with rating, title, text, author, app version and date.',
    parameters: {
      type: 'OBJECT',
      properties: {
        appId: { type: 'NUMBER', description: 'The numeric App Store track id' },
        country: { type: 'STRING', description: 'Two-letter storefront, default us' },
        sort: { type: 'STRING', description: 'mostRecent or mostHelpful', enum: ['mostRecent', 'mostHelpful'] },
      },
      required: ['appId'],
    },
  },
};
