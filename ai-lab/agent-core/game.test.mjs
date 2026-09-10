// Guess My App regression suite — no Gemini key needed, only the public
// iTunes endpoints.  node agent-core/game.test.mjs   (npm run test:game)
//
// The leak audit is the point of this file: it walks the LIVE catalog and
// proves the secret app's name cannot survive redaction. A future release
// whose store copy defeats the redactor turns the game into a giveaway, and
// nothing else in the app would notice — so this fails loudly instead.
import { seal, unseal, redactName, nameVariants, guessMatches, startGame, resumeGame, loadGame, checkGuess, giveUp, QUESTION_LIMIT } from './game.mjs';
import { listMyApps, getAppDetails } from './tools.mjs';

let fails = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) fails++; };

// ---- seal / unseal -------------------------------------------------------
const st = { appId: 6782706983, name: 'Cosmic Cadets', url: 'https://x', asked: 3, over: false };
const tok = seal(st);
const back = unseal(tok);
ok(back && back.appId === st.appId && back.name === st.name && back.asked === 3, 'token round-trips');
ok(!tok.includes('Cosmic') && !tok.includes('6782706983'), 'token is opaque (no plaintext leak)');
ok(unseal(tok.slice(0, -4) + 'AAAA') === null, 'tampered token rejected');
ok(unseal('garbage') === null && unseal('') === null && unseal(null) === null, 'malformed tokens rejected');
ok(unseal('A'.repeat(9000)) === null, 'oversized token rejected');

// ---- guess matching ------------------------------------------------------
ok(guessMatches('Cosmic Cadets', 'Cosmic Cadets'), 'exact name matches');
ok(guessMatches('cosmic cadets!', 'Cosmic Cadets'), 'punctuation/case tolerant');
ok(guessMatches('Toehold', 'Toehold: Sudoku Explained'), 'short head name matches');
ok(guessMatches('Toehold: Sudoku Explained', 'Toehold: Sudoku Explained'), 'full colon name matches');
ok(!guessMatches('Streak Rings', 'Cosmic Cadets'), 'wrong app rejected');
ok(!guessMatches('to', 'Toehold: Sudoku Explained'), '2-char fragment rejected');
ok(!guessMatches('', 'Cosmic Cadets'), 'empty guess rejected');

// ---- leak audit over the whole live catalog ------------------------------
//
// Audits the REAL fact sheet for EVERY app, not a random one. The game round
// below picks at random, so a per-app defect there shows up only 1 run in N —
// which is exactly how a "Soccer 2026" / "Price Trail" issue stayed hidden
// through eight consecutive green runs. Determinism belongs in the audit.
const { apps } = await listMyApps();
console.log(`\n--- leak audit: ${apps.length} apps ---`);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The name, plus any multi-word part of it. These ARE the name and may never
 *  appear in anything the model sees, under any punctuation. */
const namePhrases = (name) =>
  [name, ...name.split(':').map((x) => x.trim()).filter((x) => x.includes(' '))];

/** The description section of a fact sheet — the only part redaction covers. */
const DESC_MARKER = 'what it does (name removed): ';
const descriptionOf = (facts) => facts.slice(facts.indexOf(DESC_MARKER) + DESC_MARKER.length);

for (const a of apps) {
  const { facts } = await resumeGame({ appId: a.appId, name: a.name, url: a.url, asked: 0, over: false });
  const problems = [];

  // Standard 1 — the name itself must be absent from the WHOLE fact sheet.
  const leaked = namePhrases(a.name).filter((x) => norm(facts).includes(norm(x)));
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
  else if (redactName(desc, a.name) !== desc) problems.push('RESIDUE in description');

  ok(problems.length === 0, `${a.name} — ${problems.join('; ') || 'clean'}`);
}

// ---- full round ----------------------------------------------------------
console.log('\n--- game round ---');
const g = await startGame();
ok(g.fresh === true, 'startGame deals a fresh round');
ok(typeof g.state.name === 'string' && g.state.name.length > 0, 'secret app chosen');
ok(namePhrases(g.state.name).every((v) => !norm(g.facts).includes(norm(v))),
   `fact sheet hides the secret name (${g.state.name})`);
const dealtDesc = descriptionOf(g.facts);
ok(redactName(dealtDesc, g.state.name) === dealtDesc, 'dealt description leaves no un-redacted name token');
ok(g.facts.includes('category:') && g.facts.includes('what it does'), 'fact sheet has playable attributes');

const wrong = checkGuess({ name: 'Definitely Not This App' }, { state: g.state });
ok(wrong.correct === false && !wrong.appName, 'wrong guess reveals nothing');
ok(g.state.over === false, 'wrong guess leaves the round open');

const right = checkGuess({ name: g.state.name }, { state: g.state });
ok(right.correct === true && right.appName === g.state.name, 'correct guess reveals the name');
ok(g.state.over === true, 'correct guess ends the round');

// resume: a finished round must deal a NEW app rather than replay the old one
const finishedToken = seal(g.state);
const next = await loadGame(finishedToken);
ok(next.fresh === true, 'finished round deals a new app on the next turn');

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
