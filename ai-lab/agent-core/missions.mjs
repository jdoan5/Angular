// Math Mission Maker: schema-constrained generation (Gemini responseSchema →
// validated JSON), in the spirit of Cosmic Cadets. No tools, no chat — a
// single structured call whose output the UI renders as a playable mission.
// Server-side only, like the rest of the agent core.

import { makeGenAI } from './client.mjs';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

export const SKILLS = {
  counting: 'counting and number recognition',
  addition: 'addition',
  subtraction: 'subtraction',
  missing: 'finding the missing number in an equation',
  comparison: 'comparing numbers (which is more / less)',
  multiplication: 'intro multiplication as groups of 2, 5 or 10',
};

const PROBLEM_COUNT = 5;
const CHOICES = 4;

/** Number ranges per difficulty tier, mirroring the Cosmic Cadets curve.
 *  `level` is the digit that goes into the prompt: the tier the caller passed
 *  is used purely as a lookup key, so nothing from the request is ever
 *  interpolated as text. `max` is the top of the range `guide` describes —
 *  keep the two in step; the validator's choice cap is built from it. */
const TIER_GUIDE = {
  1: { level: '1', max: 5, guide: 'numbers up to 5; very simple words' },
  2: { level: '2', max: 10, guide: 'numbers up to 10' },
  3: { level: '3', max: 15, guide: 'numbers up to 15' },
  4: { level: '4', max: 20, guide: 'numbers up to 20, sums may cross ten' },
  5: { level: '5', max: 20, guide: 'numbers up to 20 with regrouping; multiplication may use groups of 2, 5 or 10' },
};

/** Skills where every problem is one step of arithmetic. Their equation is
 *  mandatory: it is the only thing the marked answer can be checked against,
 *  and an unreadable one used to skip the check silently. */
const ARITHMETIC_SKILLS = new Set(['addition', 'subtraction', 'missing', 'multiplication']);

const MISSION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: 'Short space-adventure mission name' },
    intro: { type: 'STRING', description: 'One friendly sentence setting the scene for a child' },
    problems: {
      type: 'ARRAY',
      minItems: `${PROBLEM_COUNT}`,
      maxItems: `${PROBLEM_COUNT}`,
      items: {
        type: 'OBJECT',
        properties: {
          question: { type: 'STRING', description: 'One short, kid-friendly word problem sentence' },
          equation: { type: 'STRING', description: 'One-step equation with ? in place of the answer, like "3 + 4 = ?", "9 - ? = 5" or "3 x 5 = ?". Required for adding, subtracting, missing-number and multiplication missions. For comparison, the two numbers with ? between them, like "7 ? 4", or an empty string; for counting, an empty string unless a sequence like "1, 2, 3, ?" fits' },
          // The SDK types minimum/maximum as numbers (unlike minItems/maxItems,
          // which it types as strings), so these are plain numbers.
          choices: { type: 'ARRAY', minItems: `${CHOICES}`, maxItems: `${CHOICES}`, items: { type: 'INTEGER', minimum: 0 }, description: `Exactly ${CHOICES} distinct whole-number answer choices` },
          answerIndex: { type: 'INTEGER', minimum: 0, maximum: CHOICES - 1, description: 'Zero-based index of the correct choice' },
          hint: { type: 'STRING', description: 'A gentle nudge, not the answer' },
        },
        required: ['question', 'equation', 'choices', 'answerIndex', 'hint'],
      },
    },
  },
  required: ['title', 'intro', 'problems'],
};

/**
 * Build the system prompt out of this module's own constants.
 *
 * api/mission.mjs already allowlists `skill` and range-checks `tier`, so no
 * request can reach the prompt as text today. This function re-checks anyway,
 * because relying on a caller in another file is a guarantee that quietly
 * expires: add a second call site that forgets, and a request field becomes
 * system-prompt injection (CWE-1427). Both arguments are lookup keys here,
 * never interpolated values.
 */
function systemInstruction(skill, tier) {
  const practices = typeof skill === 'string' && Object.hasOwn(SKILLS, skill) ? SKILLS[skill] : null;
  const level = Number.isInteger(tier) && Object.hasOwn(TIER_GUIDE, tier) ? TIER_GUIDE[tier] : null;
  if (!practices || !level) {
    throw Object.assign(new Error('unknown skill or tier'), { code: 'BAD_REQUEST' });
  }
  return `You write math missions for children ages 5-8, in the style of the
iOS game Cosmic Cadets: a warm, wonder-filled space adventure. Each mission is
a set of ${PROBLEM_COUNT} bite-sized word problems.

This mission practices: ${practices}.
Difficulty tier ${level.level} of 5: ${level.guide}.

Rules:
- One short sentence per problem, concrete and visual (stars, moons, rockets,
  friendly aliens, space snacks). No violence, no scary content, no brand names.
- Exactly ${CHOICES} answer choices per problem, all distinct, all plausible
  (near the correct value). answerIndex must point at the correct one.
- The math must be exactly right — double-check each answer.
- Whole numbers only, from 0 up to this tier's range. Never write the answer
  in the equation (put ? in its place) or in the hint.
- Hints nudge ("try counting the moons one by one"), never reveal the answer.
- Vary the scenario across the ${PROBLEM_COUNT} problems; keep the mission title playful.
- Plain text only in every field — no markdown symbols.`;
}

/** Largest number a choice may be. Twice the tier's range leaves room for
 *  near-miss distractors above the answer; groups of 10 reach 100 at any tier.
 *  Throws for an unknown skill or tier rather than falling back to something
 *  looser — a validator that quietly weakens when a caller forgets the
 *  context is the same expiring guarantee systemInstruction() guards against. */
function answerCap(skill, tier) {
  const known = typeof skill === 'string' && Object.hasOwn(SKILLS, skill);
  if (!known || !Number.isInteger(tier) || !Object.hasOwn(TIER_GUIDE, tier)) {
    throw Object.assign(new Error('unknown skill or tier'), { code: 'BAD_REQUEST' });
  }
  return skill === 'multiplication' ? 100 : 2 * TIER_GUIDE[tier].max;
}

// One grammar for every way the model writes a single step of arithmetic,
// after normalizing. The old check matched only "a op b" and "a +/- _ = c",
// so "6 + 7 = ?", "? + 4 = 9", "7 − 2 =", "3 × 4", "12 ÷ 3" and a "□" blank
// all skipped it — and a wrong marked answer rode through to a child.
const FORWARD = /^(\d+|\?)([-+*/])(\d+|\?)(?:=(\d+|\?))?$/;   // a op b [= c]
const REVERSED = /^(\d+|\?)=(\d+|\?)([-+*/])(\d+|\?)$/;       // c = a op b

/** Parse one arithmetic step into { op, a, b, c, blanks } with null for a
 *  blank, or null if the text isn't one. No "=" or a bare trailing "=" means
 *  the result is the blank. */
function parseEquation(raw) {
  // Stripping spaces below would read "1 2 + 3" as 12 + 3, which is not
  // what the child sees.
  if (/\d\s+\d/.test(raw)) return null;
  const s = raw
    .replace(/＋/g, '+')
    .replace(/[‐‑‒–—−－]/g, '-')
    .replace(/[×xX*＊]/g, '*')
    .replace(/[÷/／]/g, '/')
    .replace(/＝/g, '=')
    .replace(/[_?？□☐▢](?:\s*[_?？□☐▢])*/g, '?')
    .replace(/\s+/g, '')
    .replace(/=$/, '=?');
  const f = FORWARD.exec(s);
  const r = f ? null : REVERSED.exec(s);
  if (!f && !r) return null;
  const terms = f ? [f[1], f[3], f[4] ?? '?'] : [r[2], r[4], r[1]];
  const [a, b, c] = terms.map((t) => (t === '?' ? null : Number(t)));
  return { op: f ? f[2] : r[3], a, b, c, blanks: [a, b, c].filter((t) => t === null).length };
}

const APPLY = {
  '+': (x, y) => x + y,
  '-': (x, y) => x - y,
  '*': (x, y) => x * y,
  '/': (x, y) => x / y,
};

/** The number that fills the one blank, or null when there is no single
 *  whole-number answer of 0 or more (3 − 5, 7 ÷ 2, 0 × ? = 0, ? ÷ 0 = 3). */
function solveBlank({ op, a, b, c }) {
  const v = c === null ? APPLY[op](a, b)
    : a === null ? { '+': c - b, '-': c + b, '*': c / b, '/': c * b }[op]
    : { '+': c - a, '-': a - c, '*': c / a, '/': a / c }[op];
  if (!Number.isSafeInteger(v) || v < 0) return null;
  // Substituting back catches what inverting can't: a zero divisor.
  return APPLY[op](a ?? v, b ?? v) === (c ?? v) ? v : null;
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isWhole = (n) => Number.isSafeInteger(n) && n >= 0;
const show = (v) => (typeof v === 'number' ? String(v) : v === null ? 'null' : typeof v);
const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
/** n as a standalone number: 3 is in "3 moons", not in "13" or "30". */
const mentions = (s, n) => new RegExp(`(?<!\\d)${n}(?!\\d)`).test(s);
/** A sign between two numbers ("8 > 5") says which is more all by itself. */
const SETTLES = /\d\s*[<>≤≥＜＞]\s*\d/;

/**
 * Validate the model's mission against the skill and tier it was asked for;
 * returns a list of problems (empty = valid). Each message is fed back to the
 * model for its corrective attempt, so bad content is reported, never thrown.
 */
export function validateMission(m, { skill, tier } = {}) {
  const cap = answerCap(skill, tier);
  const needsEquation = ARITHMETIC_SKILLS.has(skill);
  const errors = [];
  if (!isObject(m)) return ['mission is not an object'];
  if (!text(m.title)) errors.push('missing title');
  if (!text(m.intro)) errors.push('missing intro');
  if (!Array.isArray(m.problems) || m.problems.length !== PROBLEM_COUNT) {
    errors.push(`expected exactly ${PROBLEM_COUNT} problems`);
    return errors;
  }
  m.problems.forEach((p, i) => {
    const at = `problem ${i + 1}`;
    if (!isObject(p)) {
      errors.push(`${at}: not an object`);
      return;
    }
    if (!text(p.question)) errors.push(`${at}: missing question`);
    const hint = text(p.hint);
    if (!hint) errors.push(`${at}: missing hint`);
    if (p.equation != null && typeof p.equation !== 'string') {
      errors.push(`${at}: equation must be a string ("" if none)`);
    }
    const eq = text(p.equation);

    if (!Array.isArray(p.choices) || p.choices.length !== CHOICES) {
      errors.push(`${at}: needs exactly ${CHOICES} choices`);
      return;
    }
    // Ages 5-8: no negatives, no decimals, nothing far past the tier.
    const bad = p.choices.filter((c) => !isWhole(c) || c > cap);
    if (bad.length) {
      errors.push(`${at}: choices must be whole numbers from 0 to ${cap} (got ${bad.map(show).join(', ')})`);
    }
    if (new Set(p.choices).size !== CHOICES) errors.push(`${at}: choices must be distinct`);
    if (!Number.isInteger(p.answerIndex) || p.answerIndex < 0 || p.answerIndex >= CHOICES) {
      errors.push(`${at}: answerIndex out of range`);
      return;
    }
    const marked = p.choices[p.answerIndex];
    const quoted = `"${clip(eq)}"`;

    // Verify the marked answer is actually the right math — the one failure
    // shape that must never reach a child.
    const parsed = eq ? parseEquation(eq) : null;
    const solvable = parsed?.blanks === 1;
    const shown = solvable ? [parsed.a, parsed.b, parsed.c].filter((n) => n !== null) : [];
    // A counting or comparison answer is usually named in the question itself
    // ("Mo has 7 gems and Zib has 4"), so repeating it gives nothing away.
    // Flagging it rejected every comparison hint and equation that named the
    // two piles. Arithmetic questions don't get this pass: their numbers are
    // the operands, and one that states the result is a leak. A sign between
    // the numbers ("8 > 5") still settles the comparison by itself.
    const given = needsEquation ? [] : (text(p.question).match(/\d+/g) ?? []).map(Number);
    const onScreen = (s) => shown.includes(marked) || (given.includes(marked) && !SETTLES.test(s));
    if (solvable) {
      const val = solveBlank(parsed);
      if (val === null) errors.push(`${at}: ${quoted} has no single whole-number answer`);
      else if (marked !== val) errors.push(`${at}: the ? in ${quoted} is ${val} but the marked answer is ${show(marked)}`);
      if (shown.some((n) => n > cap)) errors.push(`${at}: ${quoted} uses numbers above ${cap}`);
    } else if (needsEquation || parsed) {
      // Arithmetic that can't be checked has no place in any skill: in a
      // counting mission "2 + 3 = 5" skipped the math check, so it could
      // appear next to a marked 4.
      const why = !eq ? 'missing equation — write one like "3 + 4 = ?"'
        : parsed?.blanks === 0 ? `${quoted} has no ? — put ? where the answer goes, never the answer itself`
        : parsed ? `${quoted} needs exactly one ?`
        : `${quoted} must be one step with one ?, like "3 + 4 = ?" or "9 - ? = 5"`;
      errors.push(`${at}: ${why}`);
    } else if (isWhole(marked) && mentions(eq, marked) && !onScreen(eq)) {
      // Counting and comparison may use free text (or none), just not text
      // that prints the answer: "1, 2, 3, 4, 5", "8 > 5".
      errors.push(`${at}: the equation ${quoted} shows the answer ${marked}`);
    }

    // A hint repeating a number already on screen gives nothing away, even
    // when it equals the answer (10 − 5 = ?, "count back 5").
    if (isWhole(marked) && mentions(hint, marked) && !onScreen(hint)) {
      errors.push(`${at}: the hint gives away the answer ${marked}`);
    }
  });
  return errors;
}

/**
 * Generate one validated mission. Retries once with the validator's feedback
 * if the first attempt is malformed.
 * @returns {{ mission: object, model: string }}
 */
export async function generateMission({ skill, tier }, signal) {
  const ai = makeGenAI();   // throws NO_KEY when credentials are missing

  const contents = [{ role: 'user', parts: [{ text: 'Generate the mission now.' }] }];
  let errors = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: systemInstruction(skill, tier),
        responseMimeType: 'application/json',
        responseSchema: MISSION_SCHEMA,
        temperature: 0.9,
        ...(signal ? { abortSignal: signal } : {}),
      },
    });

    let mission;
    try {
      mission = JSON.parse(response.text ?? '');
    } catch {
      mission = null;
    }
    errors = validateMission(mission, { skill, tier });
    if (errors.length === 0) return { mission, model: MODEL };

    // Feed the validator's complaints back for one corrected attempt. If the
    // response had no text at all, don't push an empty model part (Vertex
    // rejects those) — just reissue the original request.
    const raw = (response.text ?? '').trim();
    if (raw) {
      contents.push(
        { role: 'model', parts: [{ text: raw }] },
        { role: 'user', parts: [{ text: `That mission was invalid: ${errors.join('; ')}. Return a corrected mission as JSON.` }] },
      );
    }
  }
  // The 502 the child sees is deliberately vague, so the reasons go to the
  // function log — otherwise a validator that rejects good missions (or a
  // model that keeps failing one rule) is invisible in Vercel.
  console.warn('mission rejected twice:', JSON.stringify({ skill, tier, errors }));
  const err = new Error('The mission generator returned invalid data twice.');
  err.code = 'BAD_MISSION';
  throw err;
}
