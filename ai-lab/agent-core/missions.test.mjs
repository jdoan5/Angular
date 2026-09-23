// Math Mission Maker validator suite — pure functions only, no network and no
// Gemini key.  node --test agent-core/missions.test.mjs
//
// validateMission is the last thing between the model and a child: a mission
// it passes is played as-is. The old check silently skipped every equation
// format but two, so "6 + 7 = ?" marked 12 went out as correct. Every format
// below is one the model actually writes, marked right and marked wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMission } from './missions.mjs';

const NUDGE = 'Try counting on your fingers.';

const problem = (equation, choices, answerIndex, hint = NUDGE) =>
  ({ question: 'How many space snacks does the alien have now?', equation, choices, answerIndex, hint });

/** A mission of five copies of one problem, so a verdict on it is unambiguous. */
const missionOf = (p) => ({ title: 'Snack Run', intro: 'Help Zib count the snacks!', problems: [p, p, p, p, p] });

/** Choices around `answer`, all non-negative; the answer is always index 1. */
const around = (answer) => [answer - 1, answer, answer + 1, answer + 2];

const check = (p, skill, tier) => validateMission(missionOf(p), { skill, tier });

// ---- every equation format, marked right and marked wrong -----------------

const FORMATS = [
  // [equation, answer, skill]
  ['6 + 7 = ?', 13, 'addition'],
  ['5 + 3 = ?', 8, 'addition'],
  ['3 + 4', 7, 'addition'],
  ['3 + 4 =', 7, 'addition'],
  ['? + 4 = 9', 5, 'missing'],
  ['_ + 4 = 9', 5, 'missing'],
  ['4 + __ = 9', 5, 'missing'],
  ['4 + □ = 9', 5, 'missing'],
  ['4 + _ _ _ = 9', 5, 'missing'],
  ['9 = 4 + ?', 5, 'missing'],
  ['9 − ? = 4', 5, 'missing'],
  ['? - 3 = 4', 7, 'missing'],
  ['7 − 2 =', 5, 'subtraction'],
  ['7 – 2 = ?', 5, 'subtraction'],
  ['7 — 2', 5, 'subtraction'],
  ['7 - 2 = ?', 5, 'subtraction'],
  ['10 − 5 = ?', 5, 'subtraction'],
  ['3 × 4', 12, 'multiplication'],
  ['3 x 4 = ?', 12, 'multiplication'],
  ['3 X 4 = ?', 12, 'multiplication'],
  ['3 * 4 = ?', 12, 'multiplication'],
  ['2 × ? = 10', 5, 'multiplication'],
  ['12 ÷ 3', 4, 'multiplication'],
  ['12 / 3 = ?', 4, 'multiplication'],
  ['? ÷ 2 = 5', 10, 'multiplication'],
  // Full-width and figure-dash forms, which used to cost a needless retry.
  ['3 ＋ 4 = ?', 7, 'addition'],
  ['9 － 4 ＝ ?', 5, 'subtraction'],
  ['9 ‒ 4 = ?', 5, 'subtraction'],
  ['3 ＊ 4 = ?', 12, 'multiplication'],
  ['12 ／ 3 = ?', 4, 'multiplication'],
];

for (const [equation, answer, skill] of FORMATS) {
  test(`"${equation}" with ${answer} marked passes`, () => {
    assert.deepEqual(check(problem(equation, around(answer), 1), skill, 4), []);
  });
  test(`"${equation}" with a wrong answer marked is rejected`, () => {
    const errors = check(problem(equation, around(answer), 0), skill, 4);
    assert.equal(errors.length, 5, errors.join('\n'));
    assert.match(errors[0], new RegExp(`is ${answer} but the marked answer is ${answer - 1}`));
  });
}

// ---- arithmetic skills must carry a checkable equation --------------------

const UNCHECKABLE = [
  ['', 'missing equation'],
  ['three plus four', 'must be one step'],
  ['5 + 5 + 5 = ?', 'must be one step'],
  ['? + ? = 6', 'exactly one ?'],
  ['2 + 3 = 5', 'has no ?'],
  ['3 − 5 = ?', 'no single whole-number answer'],
  ['7 ÷ 2', 'no single whole-number answer'],
  ['0 × ? = 0', 'no single whole-number answer'],
  ['? ÷ 0 = 3', 'no single whole-number answer'],
  ['12 ÷ ? = 5', 'no single whole-number answer'],
  // Spaces are stripped before parsing, so this once read as 12 + 3.
  ['1 2 + 3 = ?', 'must be one step'],
];

for (const skill of ['addition', 'subtraction', 'missing', 'multiplication']) {
  for (const [equation, why] of UNCHECKABLE) {
    test(`${skill}: "${equation}" is rejected (${why})`, () => {
      const errors = check(problem(equation, [1, 2, 3, 5], 3), skill, 3);
      assert.ok(errors.some((e) => e.includes(why)), errors.join('\n'));
    });
  }
}

test('counting and comparison may leave the equation empty', () => {
  assert.deepEqual(check(problem('', [3, 4, 5, 6], 1), 'counting', 1), []);
  assert.deepEqual(check(problem('', [3, 4, 5, 6], 1), 'comparison', 2), []);
});

test('counting and comparison still get the math check when the equation parses', () => {
  const errors = check(problem('2 + 2 = ?', [3, 4, 5, 6], 0), 'counting', 1);
  assert.ok(errors.some((e) => e.includes('is 4 but the marked answer is 3')), errors.join('\n'));
});

test('a complete equation is rejected in counting and comparison too', () => {
  // "2 + 3 = 5" beside a marked 4 used to pass for these skills: no blank
  // meant no math check, and 4 isn't in the equation to trip the leak check.
  for (const skill of ['counting', 'comparison']) {
    for (const [equation, why] of [['2 + 3 = 5', 'has no ?'], ['? + ? = 6', 'exactly one ?']]) {
      const errors = check(problem(equation, [4, 6, 7, 8], 0), skill, 1);
      assert.equal(errors.length, 5, errors.join('\n'));
      assert.ok(errors.every((e) => e.includes(why)), `${skill} ${equation}:\n${errors.join('\n')}`);
    }
  }
});

// ---- malformed input reports, never throws --------------------------------

test('a non-object mission is reported, not thrown', () => {
  for (const m of [null, undefined, 42, 'mission', [], true]) {
    assert.deepEqual(validateMission(m, { skill: 'addition', tier: 2 }), ['mission is not an object']);
  }
});

test('non-string and null fields are reported, not thrown', () => {
  const m = {
    title: 42,
    intro: null,
    problems: [
      { question: 7, equation: '3 + 4 = ?', choices: [6, 7, 8, 9], answerIndex: 1, hint: null },
      { question: null, equation: null, choices: [6, 7, 8, 9], answerIndex: 1, hint: 12 },
      { question: 'Q?', equation: 7, choices: [6, 7, 8, 9], answerIndex: 1, hint: NUDGE },
      { question: 'Q?', equation: '3 + 4 = ?', choices: ['6', null, {}, 9], answerIndex: 1, hint: NUDGE },
      { question: 'Q?', equation: '3 + 4 = ?', choices: null, answerIndex: '1', hint: NUDGE },
    ],
  };
  const errors = validateMission(m, { skill: 'addition', tier: 2 });
  for (const expected of [
    'missing title',
    'missing intro',
    'problem 1: missing question',
    'problem 1: missing hint',
    'problem 2: missing question',
    'problem 2: missing hint',
    'problem 2: missing equation — write one like "3 + 4 = ?"',
    'problem 3: equation must be a string ("" if none)',
    'problem 4: choices must be whole numbers from 0 to 20 (got string, null, object)',
    'problem 5: needs exactly 4 choices',
  ]) {
    assert.ok(errors.includes(expected), `missing "${expected}" in:\n${errors.join('\n')}`);
  }
});

test('non-object problems are reported, not thrown', () => {
  const m = { title: 'T', intro: 'I', problems: [null, 5, 'x', [], undefined] };
  assert.deepEqual(validateMission(m, { skill: 'counting', tier: 1 }), [1, 2, 3, 4, 5].map((n) => `problem ${n}: not an object`));
});

test('wrong problem count and bad answerIndex are reported', () => {
  assert.deepEqual(validateMission({ title: 'T', intro: 'I', problems: [] }, { skill: 'counting', tier: 1 }), ['expected exactly 5 problems']);
  for (const answerIndex of [-1, 4, 1.5, '1', null]) {
    const errors = check(problem('3 + 4 = ?', [6, 7, 8, 9], answerIndex), 'addition', 2);
    assert.ok(errors.includes('problem 1: answerIndex out of range'), errors.join('\n'));
  }
});

test('an unknown skill or tier throws BAD_REQUEST instead of validating loosely', () => {
  const m = missionOf(problem('3 + 4 = ?', [6, 7, 8, 9], 1));
  for (const ctx of [undefined, {}, { skill: 'addition' }, { skill: 'division', tier: 2 }, { skill: 'addition', tier: 6 }, { skill: 'toString', tier: 1 }]) {
    assert.throws(() => validateMission(m, ctx), { code: 'BAD_REQUEST' });
  }
});

// ---- content fit for ages 5-8 ---------------------------------------------

test('negative, decimal and out-of-range choices are rejected', () => {
  const cases = [
    // [equation, choices, answerIndex, skill, tier, offending]
    ['3 - 2 = ?', [-1, 0, 1, 2], 2, 'subtraction', 2, '-1'],
    ['1 + 1 = ?', [1.5, 2, 3, 4], 1, 'addition', 2, '1.5'],
    ['5 + 5 = ?', [9, 10, 11, 12], 1, 'addition', 1, '11, 12'],       // cap 10
    ['10 + 9 = ?', [19, 20, 21, 22], 0, 'addition', 2, '21, 22'],     // cap 20
    ['15 + 15 = ?', [30, 31, 29, 28], 0, 'addition', 3, '31'],        // cap 30
    ['20 + 20 = ?', [40, 41, 39, 38], 0, 'addition', 5, '41'],        // cap 40
    ['10 × 10 = ?', [100, 110, 90, 80], 0, 'multiplication', 5, '110'], // cap 100
  ];
  for (const [equation, choices, answerIndex, skill, tier, offending] of cases) {
    const errors = check(problem(equation, choices, answerIndex), skill, tier);
    assert.ok(errors.some((e) => e.includes(`choices must be whole numbers`) && e.includes(`(got ${offending})`)), `${equation}:\n${errors.join('\n')}`);
  }
});

test('choices at the edge of each cap pass', () => {
  assert.deepEqual(check(problem('5 + 5 = ?', [7, 8, 9, 10], 3), 'addition', 1), []);
  assert.deepEqual(check(problem('0 + 0 = ?', [0, 1, 2, 3], 0), 'addition', 1), []);
  assert.deepEqual(check(problem('20 + 20 = ?', [37, 38, 39, 40], 3), 'addition', 4), []);
  assert.deepEqual(check(problem('10 × 10 = ?', [70, 80, 90, 100], 3), 'multiplication', 1), []);
});

test('an equation using numbers far past the tier is rejected', () => {
  const errors = check(problem('100 - 95 = ?', [4, 5, 6, 7], 1), 'subtraction', 1);
  assert.ok(errors.some((e) => e.includes('uses numbers above 10')), errors.join('\n'));
});

test('duplicate choices are rejected', () => {
  const errors = check(problem('3 + 4 = ?', [7, 7, 8, 9], 0), 'addition', 2);
  assert.ok(errors.includes('problem 1: choices must be distinct'), errors.join('\n'));
});

test('an equation that shows the answer is rejected', () => {
  const cases = [
    // [equation, skill, choices (answer at index 1), expected error]
    ['2 + 3 = 5', 'addition', [4, 5, 6, 7], 'has no ?'],
    ['5 = 2 + 3', 'addition', [4, 5, 6, 7], 'has no ?'],
    ['2 + 3 = 5', 'counting', [4, 5, 6, 7], 'has no ?'],
    ['1, 2, 3, 4, 5', 'counting', [4, 5, 6, 7], 'shows the answer 5'],
    ['8 > 5', 'comparison', [5, 8, 6, 7], 'shows the answer 8'],
  ];
  for (const [equation, skill, choices, why] of cases) {
    const errors = check(problem(equation, choices, 1), skill, 2);
    assert.ok(errors.some((e) => e.includes(why)), `${equation}:\n${errors.join('\n')}`);
  }
});

test('an operand that merely equals the answer is not "showing" it', () => {
  // 10 − 5 = ? has the answer 5 on screen as the subtrahend; that is the
  // problem, not a leak, and neither is a hint that repeats it.
  assert.deepEqual(check(problem('10 − 5 = ?', [4, 5, 6, 7], 1, 'Start at 10 and count back 5.'), 'subtraction', 2), []);
  assert.deepEqual(check(problem('5 + ? = 10', [4, 5, 6, 7], 1, 'Start at 5 and count up to 10.'), 'missing', 2), []);
});

test('a hint that states the answer is rejected', () => {
  const cases = [
    ['6 + 7 = ?', around(13), 'The answer is 13!', 'addition'],
    ['3 × 5 = ?', around(15), 'Count by fives: 5, 10, 15.', 'multiplication'],
    ['', [3, 4, 5, 6], 'Count them: 1, 2, 3, 4.', 'counting'],
    ['', [4, 7, 5, 6], 'Is 7 bigger than 4?', 'comparison'],
  ];
  for (const [equation, choices, hint, skill] of cases) {
    const answer = choices[1];
    const errors = check(problem(equation, choices, 1, hint), skill, 4);
    assert.ok(errors.includes(`problem 1: the hint gives away the answer ${answer}`), `${hint}:\n${errors.join('\n')}`);
  }
});

// ---- numbers the question already names ---------------------------------

// A comparison answer is always one of the numbers being compared, and the
// question prints both, so every equation or hint naming them used to fail.
const PILES = 'Mo has 7 gems and Zib has 4. Which is more?';
const compare = (equation, hint) => ({ question: PILES, equation, choices: [4, 7, 5, 6], answerIndex: 1, hint });

for (const equation of ['', '7 ? 4', '7 ○ 4', '7 vs 4', '7 _ 4', '7 or 4']) {
  test(`comparison "${equation}" with a hint naming both numbers passes`, () => {
    assert.deepEqual(validateMission(missionOf(compare(equation, 'Which is bigger, 7 or 4?')), { skill: 'comparison', tier: 2 }), []);
  });
}

test('a sign between the numbers still gives a comparison away', () => {
  for (const eq of ['7 > 4', '4 < 7', '7 ＞ 4']) {
    const errors = validateMission(missionOf(compare(eq, 'Picture both piles.')), { skill: 'comparison', tier: 2 });
    assert.ok(errors.includes(`problem 1: the equation "${eq}" shows the answer 7`), `${eq}:\n${errors.join('\n')}`);
  }
  const errors = validateMission(missionOf(compare('7 ? 4', 'Is 7 > 4?')), { skill: 'comparison', tier: 2 });
  assert.ok(errors.includes('problem 1: the hint gives away the answer 7'), errors.join('\n'));
});

test('a counting hint may repeat the number the question names', () => {
  const p = { question: 'Pip sees 3 moons. How many moons?', equation: '', choices: [2, 3, 4, 5], answerIndex: 1, hint: 'Touch all 3 moons as you count.' };
  assert.deepEqual(validateMission(missionOf(p), { skill: 'counting', tier: 1 }), []);
});

test('arithmetic questions get no such pass', () => {
  // Here the question's numbers are operands; one that states the sum is a
  // leak, and the hint repeating it is too.
  const p = { question: 'Mo has 3 snacks and finds 4 more, 7 in all. How many?', equation: '3 + 4 = ?', choices: [6, 7, 8, 9], answerIndex: 1, hint: 'It is 7.' };
  const errors = validateMission(missionOf(p), { skill: 'addition', tier: 2 });
  assert.ok(errors.includes('problem 1: the hint gives away the answer 7'), errors.join('\n'));
});

test('a hint with other numbers (or the answer inside a bigger one) is allowed', () => {
  assert.deepEqual(check(problem('6 + 7 = ?', around(13), 1, 'Start at 6 and count up 7 more.'), 'addition', 4), []);
  assert.deepEqual(check(problem('6 + 7 = ?', around(13), 1, 'It is less than 130 and more than 3.'), 'addition', 4), []);
  assert.deepEqual(check(problem('? + 4 = 9', around(5), 1, 'What plus 4 makes 9?'), 'missing', 2), []);
});

// ---- one realistic, known-good mission per skill --------------------------

const GOOD = {
  counting: [1, {
    title: 'Moon Count Mission',
    intro: 'Captain Pip needs help counting everything on the moon base!',
    problems: [
      { question: 'Pip sees 3 shiny moons in the sky. How many moons are there?', equation: '', choices: [2, 3, 4, 5], answerIndex: 1, hint: 'Touch all 3 moons as you count.' },
      { question: 'What number comes next: 1, 2, 3, ...?', equation: '1, 2, 3, ?', choices: [3, 4, 5, 2], answerIndex: 1, hint: 'Say the numbers out loud and keep going.' },
      { question: 'Five friendly aliens wave hello. How many aliens is that?', equation: '', choices: [4, 5, 3, 2], answerIndex: 1, hint: 'Count one finger for every alien.' },
      { question: 'A rocket has 2 round windows. How many windows?', equation: '', choices: [1, 2, 3, 4], answerIndex: 1, hint: 'Point at each window one by one.' },
      { question: 'Zib stacks 4 space cookies. How many cookies?', equation: '', choices: [3, 4, 5, 1], answerIndex: 1, hint: 'Count from the bottom cookie to the top.' },
    ],
  }],
  addition: [2, {
    title: 'Star Snack Supply Run',
    intro: 'The crew is gathering star snacks for a long trip!',
    problems: [
      { question: 'Mo has 3 star snacks and finds 4 more. How many now?', equation: '3 + 4 = ?', choices: [6, 7, 8, 5], answerIndex: 1, hint: 'Start at 3 and count up 4 more.' },
      { question: 'Two rockets launch, then 5 more follow. How many rockets?', equation: '2 + 5 = ?', choices: [6, 8, 7, 9], answerIndex: 2, hint: 'Hold up 2 fingers, then add 5.' },
      { question: 'Six moons glow and 3 more rise. How many moons?', equation: '6 + 3 = ?', choices: [8, 9, 10, 7], answerIndex: 1, hint: 'Count on from 6.' },
      { question: 'Zib eats 5 cookies, then 5 more. How many cookies?', equation: '5 + 5 = ?', choices: [9, 11, 10, 8], answerIndex: 2, hint: 'Use all the fingers on both hands.' },
      { question: 'One comet zooms by, then 7 more. How many comets?', equation: '1 + 7 = ?', choices: [7, 8, 9, 6], answerIndex: 1, hint: 'Start at 7 and count up one.' },
    ],
  }],
  subtraction: [3, {
    title: 'Asteroid Cleanup',
    intro: 'Help the robot crew clear the space lane!',
    problems: [
      { question: 'There are 12 asteroids and the robot clears 4. How many are left?', equation: '12 − 4 = ?', choices: [7, 8, 9, 6], answerIndex: 1, hint: 'Start at 12 and count back 4.' },
      { question: 'Ten balloons float and 5 drift away. How many are left?', equation: '10 − 5 = ?', choices: [4, 5, 6, 3], answerIndex: 1, hint: 'Start at 10 and count back 5.' },
      { question: 'Fifteen stars twinkle and 7 hide. How many still twinkle?', equation: '15 − 7 = ?', choices: [9, 7, 8, 10], answerIndex: 2, hint: 'Take away 5 first, then 2 more.' },
      { question: 'Zib has 9 moon rocks and gives away 3. How many are left?', equation: '9 − 3 = ?', choices: [5, 6, 7, 4], answerIndex: 1, hint: 'Count back 3 from 9.' },
      { question: 'A ship has 14 seats and 6 are taken. How many are empty?', equation: '14 − 6 = ?', choices: [8, 9, 7, 10], answerIndex: 0, hint: 'Take away 4 to reach 10, then 2 more.' },
    ],
  }],
  missing: [2, {
    title: 'The Mystery Crates',
    intro: 'Some cargo crates lost their labels — can you find the numbers?',
    problems: [
      { question: 'Mo had 3 crates and got some more. Now there are 7. How many more?', equation: '3 + ? = 7', choices: [3, 4, 5, 6], answerIndex: 1, hint: 'Count up from 3 until you reach 7.' },
      { question: 'Some aliens joined 5 friends to make 9. How many joined?', equation: '? + 5 = 9', choices: [3, 5, 4, 6], answerIndex: 2, hint: 'Count up from 5 to 9.' },
      { question: 'Eight stars shone and some faded. Now 3 shine. How many faded?', equation: '8 − ? = 3', choices: [4, 5, 6, 3], answerIndex: 1, hint: 'Count back from 8 until you reach 3.' },
      { question: 'Zib ate 2 cookies and has 6 left. How many were there at first?', equation: '? − 2 = 6', choices: [7, 9, 8, 6], answerIndex: 2, hint: 'Put the 2 eaten cookies back with the 6.' },
      { question: 'Four rockets are ready. How many more make 10?', equation: '4 + _ = 10', choices: [5, 6, 7, 4], answerIndex: 1, hint: 'Count up from 4 on your fingers.' },
    ],
  }],
  comparison: [2, {
    title: 'Bigger or Smaller?',
    intro: 'The space crew is sorting their treasure piles!',
    problems: [
      { question: 'Mo has 7 gems and Zib has 4. Which is more?', equation: '7 ? 4', choices: [4, 7, 5, 6], answerIndex: 1, hint: 'Which is bigger, 7 or 4?' },
      { question: 'Which is less: 9 moon rocks or 6 moon rocks?', equation: '9 ? 6', choices: [9, 6, 8, 7], answerIndex: 1, hint: 'Line up 9 rocks and 6 rocks. Which row is shorter?' },
      { question: 'One rocket has 3 windows, another has 8. Which is more?', equation: '3 ? 8', choices: [3, 5, 8, 6], answerIndex: 2, hint: 'Start at 3 and count up. Do you reach 8?' },
      { question: 'Which number is bigger, 10 or 2?', equation: '', choices: [2, 10, 5, 3], answerIndex: 1, hint: 'When you count, which comes later, 2 or 10?' },
      { question: 'Zib has 5 cookies and Mo has 1. Who has fewer?', equation: '5 ? 1', choices: [5, 1, 3, 4], answerIndex: 1, hint: 'Fewer means not as many. Picture 5 cookies next to 1.' },
    ],
  }],
  multiplication: [5, {
    title: 'Rocket Fuel Groups',
    intro: 'Load the fuel pods in neat little groups!',
    problems: [
      { question: 'There are 2 pods with 5 fuel cells each. How many cells?', equation: '2 × 5 = ?', choices: [7, 10, 12, 15], answerIndex: 1, hint: 'Count by fives two times.' },
      { question: 'Three crates hold 10 stars each. How many stars?', equation: '3 × 10 = ?', choices: [13, 20, 30, 40], answerIndex: 2, hint: 'Count by tens three times.' },
      { question: 'Four aliens each have 2 antennae. How many antennae?', equation: '4 × 2 = ?', choices: [6, 8, 10, 4], answerIndex: 1, hint: 'Skip-count by twos, once for each alien.' },
      { question: 'Five moons each have 5 craters. How many craters?', equation: '5 x 5 = ?', choices: [20, 25, 30, 10], answerIndex: 1, hint: 'Count by fives, once for each moon.' },
      { question: 'Six rockets each have 2 wings. How many wings?', equation: '6 × 2 = ?', choices: [10, 12, 14, 8], answerIndex: 1, hint: 'Double the number of rockets.' },
    ],
  }],
};

for (const [skill, [tier, mission]] of Object.entries(GOOD)) {
  test(`a realistic ${skill} mission at tier ${tier} passes`, () => {
    assert.deepEqual(validateMission(mission, { skill, tier }), []);
  });
}

test('every realistic mission is still caught when one answer is marked wrong', () => {
  for (const [skill, [tier, mission]] of Object.entries(GOOD)) {
    if (skill === 'counting' || skill === 'comparison') continue;   // no equation to disagree with
    const broken = structuredClone(mission);
    const p = broken.problems[2];
    p.answerIndex = (p.answerIndex + 1) % 4;
    const errors = validateMission(broken, { skill, tier });
    assert.ok(errors.length === 1 && errors[0].startsWith('problem 3: the ? in'), `${skill}:\n${errors.join('\n')}`);
  }
});
