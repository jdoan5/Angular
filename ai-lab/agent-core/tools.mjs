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
      { name: "John's AI Lab", kind: 'Angular + Gemini agents', note: 'this very app — agents with live App Store tools on Vertex AI' },
    ],
    iosAppsNote: 'The authoritative list of published iOS apps (names, ratings, versions) comes from the list_my_apps tool — always prefer it over memory.',
    highlights: [
      'Cosmic Cadets — space math adventure for kids 5-8, adaptive difficulty, no ads or purchases',
      'Streak Rings — habit tracker with an Apple Watch app and iCloud sync',
      'All apps are ad-free with no tracking; several are fully offline',
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
