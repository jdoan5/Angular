// Guess My App regression suite — no Gemini key needed, only the public
// iTunes endpoints.  node agent-core/game.test.mjs   (npm run test:game)
//
// The leak audit is the point of this file: it walks the LIVE catalog and
// proves the secret app's name cannot survive redaction. A future release
// whose store copy defeats the redactor turns the game into a giveaway, and
// nothing else in the app would notice — so this fails loudly instead.
import { seal, unseal, redactName, matchGuess, ALIASES, startGame, resumeGame, loadGame, checkGuess, giveUp, gameTools, QUESTION_LIMIT } from './game.mjs';
import { AGENTS } from './agents.mjs';
import { listMyApps } from './tools.mjs';

let fails = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fails++; };
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// ---- seal / unseal -------------------------------------------------------
const st = { appId: 6782706983, name: 'Cosmic Cadets', url: 'https://x', asked: 3, over: false };
const tok = seal(st);
const back = unseal(tok);
ok(back && back.appId === st.appId && back.name === st.name && back.asked === 3, 'token round-trips');
ok(!tok.includes('Cosmic') && !tok.includes('6782706983'), 'token is opaque (no plaintext leak)');
ok(unseal(tok.slice(0, -4) + 'AAAA') === null, 'tampered token rejected');
ok(unseal('garbage') === null && unseal('') === null && unseal(null) === null, 'malformed tokens rejected');
ok(unseal('A'.repeat(9000)) === null, 'oversized token rejected');

// api/agent.mjs slices the model's history from historyStart so an old
// round's reveal stays out; dropping it here let the reveal back in from
// question 2 of the next round.
ok(unseal(seal({ ...st, historyStart: 6 })).historyStart === 6, 'historyStart survives the round-trip');
ok(unseal(seal({ ...st, historyStart: 0 })).historyStart === 0, 'historyStart 0 survives the round-trip');
ok(!('historyStart' in back), 'no historyStart when none was sealed');
ok(['x', -1, 1.5, null].every((h) => !('historyStart' in unseal(seal({ ...st, historyStart: h })))),
   'malformed historyStart is dropped');

const { apps } = await listMyApps();
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// ---- guess matching ------------------------------------------------------
//
// Driven against the LIVE catalog: a guess is only right or wrong relative to
// every other app it might also name. Every case below was a real defect —
// the old matcher compared the guess to the secret's title alone, so it
// rejected "Snake" for LCD Classic Snake and accepted "Toeholds are fun".
console.log('\n--- guess matching ---');
const ID = {
  citizenship: 6778971932, jobTrail: 6776927520, tabwise: 6782749406, homefolio: 6806631158,
  budget: 6780275076, medical: 6772649719, streak: 6784836738, duel: 6772803398,
  snake: 6773937059, vietfix: 6796511772, cadets: 6782706983, toehold: 6801322941,
  soccer: 6776318136, pronunciation: 6775637573,
};
const appById = new Map(apps.map((a) => [a.appId, a]));
const missing = Object.entries(ID).filter(([, id]) => !appById.has(id)).map(([k]) => k);
ok(missing.length === 0, `apps under test are still in the catalog${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);

const secretState = (appId) => {
  const a = appById.get(appId);
  return { appId, name: a?.name ?? '', url: a?.url ?? '', asked: 1, over: false };
};
const otherThan = (appId) => apps.find((a) => a.appId !== appId).appId;

// Right guesses: the matcher names the app, and check_guess wins for it and
// only for it.
const RIGHT = [
  ['VietFix', ID.vietfix], ['Job Trail', ID.jobTrail], ['Three in a Row', ID.duel],
  ['3 in a row', ID.duel], ['Tic Tac Toe', ID.duel], ['Snake', ID.snake],
  ['Classic Snake', ID.snake], ['US Citizenship', ID.citizenship], ['Medical Refill', ID.medical],
  ['cosmic cadet', ID.cadets], ['Budget Coach', ID.budget], ['Home Inventory', ID.homefolio],
  ['Sudoku Explained', ID.toehold], ['is it Cosmic Cadets?', ID.cadets], ['is it Toehold?', ID.toehold],
  ['Cosmic Cadets', ID.cadets], ['cosmic cadets!', ID.cadets], ['Toehold', ID.toehold],
  ['Toehold: Sudoku Explained', ID.toehold],
  // Genre words are generic alone but still name the app inside its title.
  ['Soccer 2026', ID.soccer], ['Learn English', ID.pronunciation], ['Streak Rings', ID.streak],
];
for (const [guess, id] of RIGHT) {
  const named = matchGuess(guess, apps);
  const win = await checkGuess({ name: guess }, { state: secretState(id) });
  const lose = await checkGuess({ name: guess }, { state: secretState(otherThan(id)) });
  ok(same(named, [id]) && win.correct === true && lose.correct === false,
     `"${guess}" names ${appById.get(id)?.name} and wins only for it`);
}

// Each full title and colon head names exactly its own app.
const selfMisses = apps
  .flatMap((a) => [a.name, a.name.split(':')[0]].map((n) => [n, a.appId]))
  .filter(([n, id]) => !same(matchGuess(n, apps), [id]))
  .map(([n]) => n);
ok(selfMisses.length === 0, `every title and colon head names only its own app${selfMisses.length ? ` (${selfMisses.join(' | ')})` : ''}`);

// Every alias counts as the app it belongs to.
for (const [id, list] of Object.entries(ALIASES)) {
  for (const { name } of list) {
    const win = await checkGuess({ name }, { state: secretState(Number(id)) });
    ok(same(matchGuess(name, apps), [Number(id)]) && win.correct === true,
       `alias "${name}" wins for ${appById.get(Number(id))?.name}`);
  }
}

// Not app names: questions, fragments, generic title words and invented apps
// must name nothing. The four Guess starters from app.ts are here too — a
// starter scored as a guess would spend the player's one guess on a question.
const NOTHING = [
  'Toeholds are fun', 'Is it a game?', 'Is it for learning English?', 'is it a budget app?',
  'is it about home stuff?', 'Is it for kids?', 'Is it about money?', 'Is it an education app?',
  'Moon Muffins', 'is it Moon Muffins?', 'English', 'Budget', 'Classic', 'Home', 'Trail', '2026',
  'in a row', 'to', '',
  // Genre questions: each word is in exactly one title, so without the
  // stoplist these named (and could win) Toehold, Soccer 2026, US
  // Citizenship, Learn English and Streak Rings.
  'Is it a sudoku app?', 'is it about soccer?', 'Is it a citizenship app?',
  'is it a pronunciation app?', 'does it keep a streak?',
];
for (const guess of NOTHING) ok(matchGuess(guess, apps).length === 0, `"${guess}" names no app`);
const toeholds = await checkGuess({ name: 'Toeholds are fun' }, { state: secretState(ID.toehold) });
ok(toeholds.correct === false && !toeholds.appName, '"Toeholds are fun" does not win for Toehold');
const sudokuQ = await checkGuess({ name: 'Is it a sudoku app?' }, { state: secretState(ID.toehold) });
ok(sudokuQ.correct === false && sudokuQ.recognized === false && !sudokuQ.appName,
   'a sudoku question sent as a guess does not win for Toehold');

// Two apps at once is not a guess.
for (const guess of ['Streak Rings or Cosmic Cadets', 'Cosmic Cadets or Streak Rings']) {
  const r = await checkGuess({ name: guess }, { state: secretState(ID.cadets) });
  ok(same(matchGuess(guess, apps), [ID.streak, ID.cadets]) && r.error === 'Name one app at a time' && !r.appName,
     `"${guess}" is refused as two apps, not won`);
}

// Pure, with a fixed catalog: a longer title is not also read as a shorter
// app's name inside it, but a word both could claim is ambiguous.
const fixed = [{ appId: 1, name: 'Snake Duel' }, { appId: 2, name: 'LCD Classic Snake' }];
ok(same(matchGuess('LCD Classic Snake', fixed), [2]), 'longest phrase claims its words first');
ok(same(matchGuess('Snake', fixed), [1, 2]), 'a word shared by two titles names both (ambiguous)');

// ---- one guess per question ----------------------------------------------
console.log('\n--- one guess per question ---');
const ONE_GUESS = 'One guess per question - ask the player which single app they mean';
{
  const turn = { state: secretState(ID.cadets) };
  const first = await checkGuess({ name: 'Streak Rings' }, turn);
  const second = await checkGuess({ name: 'Cosmic Cadets' }, turn);
  ok(first.correct === false, 'first guess of the turn is judged');
  ok(second.error === ONE_GUESS && !second.appName && turn.state.over === false,
     'second guess in the same turn is refused without being judged');
  ok((await giveUp({}, turn)).appName === turn.state.name, 'give_up still works after the turn\'s guess');
}
{
  const turn = { state: secretState(ID.cadets) };
  await checkGuess({ name: 'Streak Rings or Cosmic Cadets' }, turn);
  ok((await checkGuess({ name: 'Cosmic Cadets' }, turn)).correct === true, 'naming two apps does not spend the turn\'s guess');
}
{
  const turn = { state: secretState(ID.cadets) };
  const r = await checkGuess({ name: 'Moon Muffins' }, turn);
  ok(r.correct === false && r.recognized === false, 'an invented name is not an app');
  ok((await checkGuess({ name: 'Cosmic Cadets' }, turn)).correct === true, 'an invented name does not spend the turn\'s guess');
}
ok((await checkGuess({ name: 'Cosmic Cadets' }, { state: secretState(ID.cadets) })).correct === true,
   'a fresh turn gets a fresh guess');

// ---- leak audit over the whole live catalog ------------------------------
//
// Audits the REAL fact sheet for EVERY app, not a random one. The game round
// below picks at random, so a per-app defect there shows up only 1 run in N —
// which is exactly how a "Soccer 2026" / "Price Trail" issue stayed hidden
// through eight consecutive green runs. Determinism belongs in the audit.
console.log(`\n--- leak audit: ${apps.length} apps ---`);

/** The name, any multi-word part of it, and its proper-noun aliases. These
 *  ARE the name and may never appear in anything the model sees, under any
 *  punctuation. */
const namePhrases = (name, appId) => [
  name,
  ...name.split(':').map((x) => x.trim()).filter((x) => x.includes(' ')),
  ...(ALIASES[appId] ?? []).filter((a) => a.redact).map((a) => a.name),
];

/** The description section of a fact sheet — the only part redaction covers. */
const DESC_MARKER = 'what it does (name removed): ';
const descriptionOf = (facts) => facts.slice(facts.indexOf(DESC_MARKER) + DESC_MARKER.length);

for (const a of apps) {
  const { facts } = await resumeGame({ appId: a.appId, name: a.name, url: a.url, asked: 0, over: false });
  const problems = [];

  // Standard 1 — the name itself must be absent from the WHOLE fact sheet.
  const leaked = namePhrases(a.name, a.appId).filter((x) => norm(facts).includes(norm(x)));
  if (leaked.length) problems.push('LEAKS: ' + leaked.join(' | '));

  // Standard 2 — no residue in the description: if a second redaction pass
  // would still find something, the first missed a standalone name word.
  //
  // Scoped to the description on purpose. The metadata lines above it are
  // generated from constants and store fields, where a name word can appear
  // legitimately — "Soccer 2026: Live Scores" meets `released: June 2026`,
  // "Price Trail: Drop Alerts" meets `price: free`. Redacting those would leak
  // far MORE than leaving them: `price: [the app name]` announces that the
  // name contains "price". (An inflection like "prices" is not residue either
  // — it is ordinary domain vocabulary, and scrubbing it leaves no clues.)
  const desc = descriptionOf(facts);
  if (!desc) problems.push('no description section');
  else if (redactName(desc, a.name, a.appId) !== desc) problems.push('RESIDUE in description');

  ok(problems.length === 0, `${a.name} — ${problems.join('; ') || 'clean'}`);
}

// Genre aliases describe the app, so they stay in the clue.
ok(redactName('Tic Tac Toe is a calm take', 'Three in a Row Duel', ID.duel).startsWith('Tic Tac Toe'),
   'genre alias "Tic Tac Toe" is left in the fact sheet');
ok(redactName('Habit Tracker is a calm, focused habit tracker', 'Streak Rings', ID.streak).startsWith('Habit Tracker'),
   'genre alias "Habit Tracker" is left in the fact sheet');

// ---- the host prompt names no real app -----------------------------------
//
// Everything here reaches the model on every turn. An example guess that is a
// real app ("is it Cosmic Cadets?") primes the host with one fifteenth of the
// answer key.
const hostText = norm([
  AGENTS.guess.systemInstruction,
  gameTools.check_guess.description,
  gameTools.check_guess.parameters.properties.name.description,
  gameTools.give_up.description,
].join('\n'));
const inPrompt = apps
  .flatMap((a) => [a.name, a.name.split(':')[0], ...(ALIASES[a.appId] ?? []).map((x) => x.name)])
  .filter((n) => hostText.includes(norm(n)));
ok(inPrompt.length === 0, `guess prompt and tool text name no catalog app${inPrompt.length ? ` (${inPrompt.join(' | ')})` : ''}`);

// ---- full round ----------------------------------------------------------
console.log('\n--- game round ---');
const g = await startGame();
ok(g.fresh === true, 'startGame deals a fresh round');
ok(typeof g.state.name === 'string' && g.state.name.length > 0, 'secret app chosen');
ok(namePhrases(g.state.name, g.state.appId).every((v) => !norm(g.facts).includes(norm(v))),
   `fact sheet hides the secret name (${g.state.name})`);
const dealtDesc = descriptionOf(g.facts);
ok(redactName(dealtDesc, g.state.name, g.state.appId) === dealtDesc, 'dealt description leaves no un-redacted name token');
ok(g.facts.includes('category:') && g.facts.includes('what it does'), 'fact sheet has playable attributes');

const wrong = await checkGuess({ name: 'Definitely Not This App' }, { state: g.state });
ok(wrong.correct === false && !wrong.appName, 'wrong guess reveals nothing');
ok(g.state.over === false, 'wrong guess leaves the round open');

const right = await checkGuess({ name: g.state.name }, { state: g.state });
ok(right.correct === true && right.appName === g.state.name, 'correct guess reveals the name');
ok(g.state.over === true, 'correct guess ends the round');

// resume: a finished round must deal a NEW app rather than replay the old one
const finishedToken = seal(g.state);
const next = await loadGame(finishedToken);
ok(next.fresh === true, 'finished round deals a new app on the next turn');

// ...and never the app it just revealed, whose name may still be in the
// history the model reads. Was 1 draw in 15; 40 draws catch a regression in
// about 94% of runs ((14/15)^40 is a 6% miss).
let redeals = 0;
for (let i = 0; i < 40; i++) {
  if ((await loadGame(finishedToken)).state.appId === g.state.appId) redeals++;
}
ok(redeals === 0, `a finished round never re-deals the revealed app (${redeals}/40 re-deals)`);

// resume: an in-progress round must keep the same app
const live = { appId: g.state.appId, name: g.state.name, url: g.state.url, asked: 4, over: false };
const resumed = await loadGame(seal(live));
ok(resumed.fresh === false && resumed.state.appId === live.appId, 'in-progress round resumes the same app');
ok(resumed.state.asked === 4, 'question count survives the round-trip');

const gaveUp = giveUp({}, { state: resumed.state });
ok(gaveUp.appName === live.name && resumed.state.over === true, 'give_up reveals and ends');

// unknown token → fresh game, never a crash
ok((await loadGame('not-a-real-token')).fresh === true, 'bad token starts a new round gracefully');
ok((await loadGame(undefined)).fresh === true, 'missing token starts a new round');

console.log(`\nQUESTION_LIMIT = ${QUESTION_LIMIT}`);
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
