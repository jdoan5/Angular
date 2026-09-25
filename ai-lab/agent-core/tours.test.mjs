// Screenshot Tour suite: the URL guard, shot selection, quote grounding, the
// validator and generateTour against a scripted model, then key-free live
// checks against iTunes and mzstatic. Never calls Gemini.
//   node --test agent-core/tours.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL, MAX_SHOT_BYTES, LIVE_TOURS_PER_HOUR, LIVE_CEILING_MSG, HIDDEN_APPS, isHidden,
  assertShotUrl, selectShots, tourKey, fetchShot, tourSchema, systemInstruction, buildContents,
  norm, findQuote, validateTour, generateTour, listTourApps, lookupTour, tourApp,
  _setFetcherForTests, _setCatalogForTests, _setSnapshotForTests, _resetForTests,
} from './tours.mjs';
import { catalogApps } from './tools.mjs';
import { visitorError } from '../api/tour.mjs';
import { RATE_LIMIT_MSG } from './ratelimit.mjs';

// Read lazily by client.mjs: with these unset, any path that reached the real
// client would throw NO_KEY instead of calling Gemini.
for (const k of ['GEMINI_API_KEY', 'GEMINI_AUTH', 'GEMINI_VERTEX', 'GOOGLE_CLOUD_PROJECT']) {
  delete process.env[k];
}

// ------------------------------------------------------------------ fixtures

const TOEHOLD = 6801322941;
const STREAK = 6784836738;
const SNAKE = 6773937059;

// The shape of every screenshot URL in the live catalog on 2026-09-25.
const REAL_SHOT = 'https://is1-ssl.mzstatic.com/image/thumb/PurpleSource221/v4/21/1c/00/211c000d-8f1e-34da-91cf-fbfce61a2851/01-reading.png/320x480bb.jpg';
const shotUrl = (id, name, size = '392x696bb.jpg') =>
  `https://is1-ssl.mzstatic.com/image/thumb/PurpleSource211/v4/ab/cd/ef/${id}-0000-4000-8000-000000000000/${name}.png/${size}`;
const tourSize = (url) => url.replace(/[^/]+$/, '600x1300bb.jpg');

// Bullets, newlines and an em dash, like every description in the catalog.
const DESC = [
  'Every other sudoku app has a hint button. You get stuck, you tap it, it fills in a square, and you have learned nothing.',
  '',
  'A panel sits beside your board and keeps a live inventory of the techniques that are available right now — updating on every digit and every pencil mark.',
  '',
  '• Eleven named techniques, from Hidden Single to X-Wing',
  '• Difficulty graded by the hardest technique a puzzle requires',
  '• Every puzzle has exactly one solution reachable by logic alone',
  '',
  'Tap a technique and it shows you the cells that make it true.',
  '',
  'No ads. No account. No tracking.',
].join('\n');

const QUOTES = [
  'keeps a live inventory of the techniques that are available right now',
  'Eleven named techniques, from Hidden Single to X-Wing',
  'Difficulty graded by the hardest technique a puzzle requires',
  'Every puzzle has exactly one solution reachable by logic alone',
  'it shows you the cells that make it true',
  'Every other sudoku app has a hint button',
  'updating on every digit and every pencil mark',
  'You get stuck, you tap it, it fills in a square',
];

// Store order deliberately not filename order, as Toehold's really is.
const TOEHOLD_SHOTS = ['01-reading', '02-technique', '03-notes', '05-gentle', '04-tough'].map((n) => shotUrl('toe', n));

const appOf = (trackId, trackName, screenshotUrls, { version = '1.0', description = DESC } = {}) => ({
  wrapperType: 'software',
  trackId,
  trackName,
  version,
  description,
  artworkUrl512: `https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/ab/46/49/${trackId}/AppIcon.png/512x512bb.jpg`,
  screenshotUrls,
});

const CATALOG = [
  appOf(TOEHOLD, 'Toehold: Sudoku Explained', TOEHOLD_SHOTS),
  appOf(STREAK, 'Streak Rings', ['a', 'b', 'c', 'd'].map((n) => shotUrl('streak', n)), { version: '1.0.3' }),
  appOf(SNAKE, 'LCD Classic Snake', ['01-play', '02-leaderboard', '03-players'].map((n) => shotUrl('snake', n)), { version: '1.2' }),
  appOf(111, 'Two Shots Only', ['a', 'b'].map((n) => shotUrl('two', n))),
];

const jpeg = (size = 2048) => {
  const b = Buffer.alloc(size, 0x11);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
};
const jpegResponse = (body = jpeg(), headers = {}) =>
  new Response(body, { headers: { 'content-type': 'image/jpeg', ...headers } });

/** Fresh module state with a fake catalog, snapshot and screenshot fetcher. */
function setup({ catalog = CATALOG, snapshot = {} } = {}) {
  _resetForTests();
  _setCatalogForTests(async () => catalog);
  _setSnapshotForTests(snapshot);
  const fetches = [];
  _setFetcherForTests(async (url, init) => { fetches.push({ url, init }); return jpegResponse(); });
  return { fetches };
}

/** A callout per `per` on each of n shots, every one valid against DESC. */
const goodCallouts = (n, per = 2) => Array.from({ length: n * per }, (_, i) => ({
  shot: Math.floor(i / per),
  box_2d: [100 + (i % per) * 300, 50, 350 + (i % per) * 300, 950],
  label: `Feature ${i + 1}`,
  quote: QUOTES[i % QUOTES.length],
}));

// ------------------------------------------------------------------ URL guard

test('assertShotUrl accepts a real catalog URL and rewrites it to 600x1300bb.jpg', () => {
  assert.equal(assertShotUrl(REAL_SHOT), REAL_SHOT.replace('320x480bb.jpg', '600x1300bb.jpg'));
  assert.equal(assertShotUrl(shotUrl('x', '03_bracket', '392x696bb.png')), tourSize(shotUrl('x', '03_bracket')));
  const once = assertShotUrl(REAL_SHOT);
  assert.equal(assertShotUrl(once), once, 'idempotent on an already rewritten URL');
});

const REJECTED = [
  ['http, not https', REAL_SHOT.replace('https:', 'http:')],
  ['another mzstatic host', REAL_SHOT.replace('is1-ssl', 'is2-ssl')],
  ['a look-alike host', REAL_SHOT.replace('mzstatic.com', 'mzstatic.com.example.org')],
  ['userinfo', REAL_SHOT.replace('https://', 'https://user:pw@')],
  ['userinfo before the real host', 'https://is1-ssl.mzstatic.com@example.org/image/thumb/a/b/c.png/320x480bb.jpg'],
  ['a port', REAL_SHOT.replace('.com/', '.com:443/')],
  ['a query', `${REAL_SHOT}?w=100`],
  ['a fragment', `${REAL_SHOT}#x`],
  ['dot-dot traversal', REAL_SHOT.replace('/v4/', '/v4/../../')],
  ['encoded traversal', REAL_SHOT.replace('/v4/', '/%2e%2e/')],
  ['a backslash', REAL_SHOT.replace('/v4/', '/v4\\')],
  ['a path outside /image/thumb', REAL_SHOT.replace('/image/thumb/', '/image/other/')],
  ['no size segment', REAL_SHOT.replace('/320x480bb.jpg', '')],
  ['a gif size segment', REAL_SHOT.replace('bb.jpg', 'bb.gif')],
  ['a size without bb', REAL_SHOT.replace('320x480bb.jpg', '320x480.jpg')],
  ['uppercase scheme', REAL_SHOT.replace('https:', 'HTTPS:')],
  ['a non-string', 42],
  ['an empty string', ''],
];
for (const [why, url] of REJECTED) {
  test(`assertShotUrl rejects ${why}`, () => {
    assert.throws(() => assertShotUrl(url), /not an App Store screenshot URL/);
  });
}

// ------------------------------------------------------------ shot selection

test('selectShots keeps store order (not filename order) and stops at 4', () => {
  const shots = selectShots(CATALOG[0]);
  assert.deepEqual(shots, TOEHOLD_SHOTS.slice(0, 4).map(tourSize));
  assert.match(shots[3], /05-gentle\.png\/600x1300bb\.jpg$/, 'the store shows 05 before 04');
});

test('selectShots: an app with 3 uses 3; bad and repeated URLs are skipped, not fatal', () => {
  assert.equal(selectShots(CATALOG[2]).length, 3);
  const [a, b, c, d] = TOEHOLD_SHOTS;
  const shots = selectShots({ screenshotUrls: [a, 'https://example.org/x.jpg', a, b, null, c, d] });
  assert.deepEqual(shots, [a, b, c, d].map(tourSize));
  assert.deepEqual(selectShots({}), []);
  assert.deepEqual(selectShots(null), []);
});

test('tourKey is stable, and changes with the version or the screenshot order', () => {
  const shots = selectShots(CATALOG[0]);
  const key = tourKey(TOEHOLD, '1.0', shots);
  assert.match(key, /^6801322941:1\.0:[0-9a-f]{12}$/);
  assert.equal(tourKey(TOEHOLD, '1.0', [...shots]), key);
  assert.notEqual(tourKey(TOEHOLD, '1.1', shots), key);
  assert.notEqual(tourKey(TOEHOLD, '1.0', [shots[1], shots[0], ...shots.slice(2)]), key);
});

test('HIDDEN_APPS holds Streak Rings and nothing else', () => {
  assert.deepEqual(Object.keys(HIDDEN_APPS), [String(STREAK)]);
  assert.equal(isHidden(STREAK), true);
  assert.equal(isHidden(TOEHOLD), false);
  assert.equal(isHidden('__proto__'), false);
  assert.ok(Object.isFrozen(HIDDEN_APPS));
});

// ---------------------------------------------------------- quote matching

test('norm folds dashes, bullets, whitespace and case, and maps back to the original', () => {
  const n = norm('A — b\n\n•  C');
  assert.equal(n.text, 'a - b c');
  assert.equal(n.from.length, n.text.length);
  assert.equal(n.to.length, n.text.length);
});

const MATCHES = [
  ['an em dash typed as a hyphen', 'available right now - updating on every digit', 'available right now — updating on every digit'],
  ['a bullet and newline typed as one space', 'from Hidden Single to X-Wing Difficulty graded by', 'from Hidden Single to X-Wing\n• Difficulty graded by'],
  ['upper case with a trailing period', 'EVERY PUZZLE HAS EXACTLY ONE SOLUTION.', 'Every puzzle has exactly one solution'],
  ['curly quotes wrapped around it', '“it shows you the cells that make it true.”', 'it shows you the cells that make it true'],
  ['a ligature (NFKC)', 'it ﬁlls in a square', 'it fills in a square'],
  ['full-width letters (NFKC)', 'Ｎo ads. Ｎo account', 'No ads. No account'],
];
for (const [why, quote, span] of MATCHES) {
  test(`findQuote matches ${why} and returns the ORIGINAL span`, () => {
    const hit = findQuote(DESC, quote);
    assert.ok(hit, 'matched');
    assert.equal(hit.text, span);
    assert.equal(DESC.slice(hit.start, hit.end), span);
  });
}

test('findQuote composes decomposed accents before comparing (Vietnamese)', () => {
  const vi = 'Học tiếng Anh bằng tiếng Việt, từng lỗi một.';
  const hit = findQuote(vi, 'bằng tiếng Việt, từng lỗi'.normalize('NFD'));
  assert.equal(hit?.text, 'bằng tiếng Việt, từng lỗi');
});

test('findQuote refuses paraphrase, a start inside a word, and empty quotes', () => {
  assert.equal(findQuote(DESC, 'Learn eleven sudoku techniques with gentle hints'), null);
  assert.equal(findQuote(DESC, 'ery other sudoku app has a hint button'), null);
  assert.equal(findQuote(DESC, 'Every other sudoku app has a hint butto'), null);
  assert.equal(findQuote(DESC, ' "". '), null);
  assert.equal(findQuote(DESC, ''), null);
});

// ------------------------------------------------------------------ validator

const V = (callouts, n = 4) => validateTour({ callouts }, { n, description: DESC });
const one = (over = {}) => ({ shot: 0, box_2d: [100, 50, 350, 950], label: 'Technique panel', quote: QUOTES[0], ...over });

const DROPS = [
  ['shot out of range', { shot: 4 }],
  ['shot out of range', { shot: -1 }],
  ['shot out of range', { shot: 1.5 }],
  ['shot out of range', { shot: '1' }],
  ['box out of range', { box_2d: [100, 50, 1001, 950] }],
  ['box out of range', { box_2d: [-5, 50, 300, 950] }],
  ['box out of range', { box_2d: [100, 50, 350] }],
  ['box out of range', { box_2d: [400, 50, 350, 950] }],
  ['box out of range', { box_2d: [100.5, 50, 350, 950] }],
  ['box out of range', { box_2d: '100,50,350,950' }],
  ['status bar', { box_2d: [0, 20, 50, 300] }],
  ['box too small', { box_2d: [500, 100, 510, 900] }],
  ['box too small', { box_2d: [500, 100, 700, 110] }],
  ['no label', { label: '  ' }],
  ['quote too short', { quote: 'No ads.' }],
  ['quote not in listing', { quote: 'Learn eleven sudoku techniques with gentle hints' }],
];
for (const [reason, over] of DROPS) {
  test(`validateTour drops "${reason}": ${JSON.stringify(over)}`, () => {
    const v = V([one(over)]);
    assert.deepEqual(v.callouts, []);
    assert.deepEqual(v.dropped, { count: 1, reasons: { [reason]: 1 } });
    assert.equal(v.pass, false);
  });
}

test('validateTour drops duplicates: the same span or the same box on one screenshot', () => {
  const v = V([
    one(),
    one({ box_2d: [400, 50, 650, 950] }),              // same quote, same shot
    one({ quote: QUOTES[1] }),                          // same box, same shot
    one({ shot: 1 }),                                   // same quote, other shot: kept
  ]);
  assert.deepEqual(v.dropped, { count: 2, reasons: { duplicate: 2 } });
  assert.deepEqual(v.callouts.map((c) => c.shot), [0, 1]);
});

test('validateTour keeps the ORIGINAL span as the quote, clips labels, sorts pins', () => {
  const v = V([
    one({ shot: 1, box_2d: [600, 50, 800, 950], quote: 'available right now - updating on every digit.' }),
    one({ shot: 1, box_2d: [100, 50, 300, 950], label: `  **${'A very long label that goes on and on'.repeat(2)}**` }),
    one({ shot: 0, box_2d: [400, 50, 650, 950], quote: QUOTES[2] }),
  ]);
  assert.deepEqual(v.callouts.map((c) => [c.shot, c.box_2d[0]]), [[0, 400], [1, 100], [1, 600]]);
  assert.equal(v.callouts[2].quote, 'available right now — updating on every digit');
  assert.equal(Array.from(v.callouts[1].label).length, 40);
  assert.ok(v.callouts[1].label.endsWith('…'));
  assert.ok(!v.callouts[1].label.includes('*'));
});

test('validateTour pass rule: 6+ kept with one on every shot (4 shots), 4+ for 3 shots', () => {
  assert.equal(V(goodCallouts(4)).pass, true, '8 across 4 shots');
  const six = goodCallouts(4).slice(0, 6);   // shots 0-2 only
  assert.equal(V(six).pass, false, 'shot 3 has none');
  assert.deepEqual(V(six).perShot, [2, 2, 2, 0]);
  const fiveAll = [...goodCallouts(4).filter((c, i) => i % 2 === 0), goodCallouts(4)[1]];
  assert.equal(fiveAll.length, 5);
  assert.equal(V(fiveAll).pass, false, '5 is too few even on every shot');
  assert.equal(V([...fiveAll, goodCallouts(4)[3]]).pass, true, '6 with every shot covered');
  const three = goodCallouts(3);
  assert.equal(V(three.slice(0, 4), 3).pass, false, 'shot 2 has none');
  assert.equal(V([three[0], three[1], three[2], three[4]], 3).pass, true, '4 across 3 shots');
  assert.equal(V([three[0], three[2], three[4]], 3).pass, false, '3 is too few');
});

test('validateTour: a response without a callouts array is malformed, not a crash', () => {
  for (const raw of [null, 'x', [], { callouts: 'x' }]) {
    const v = validateTour(raw, { n: 4, description: DESC });
    assert.equal(v.malformed, true);
    assert.equal(v.pass, false);
    assert.equal(v.received, 0);
  }
  assert.throws(() => validateTour({ callouts: [] }, { n: 5, description: DESC }), /bad tour request/);
});

//__APPEND_HERE__
