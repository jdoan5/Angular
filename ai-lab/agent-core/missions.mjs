// Math Mission Maker: schema-constrained generation (Gemini responseSchema →
// validated JSON), in the spirit of Cosmic Cadets. No tools, no chat — a
// single structured call whose output the UI renders as a playable mission.
// Server-side only, like the rest of the agent core.

import { GoogleGenAI } from '@google/genai';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const USE_VERTEX = process.env.GEMINI_VERTEX === '1';

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

/** Number ranges per difficulty tier, mirroring the Cosmic Cadets curve. */
const TIER_GUIDE = {
  1: 'numbers up to 5; very simple words',
  2: 'numbers up to 10',
  3: 'numbers up to 15',
  4: 'numbers up to 20, sums may cross ten',
  5: 'numbers up to 20 with regrouping; multiplication may use groups of 2, 5 or 10',
};

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
          equation: { type: 'STRING', description: 'Optional compact equation like "3 + 4"; empty string if none' },
          choices: { type: 'ARRAY', minItems: `${CHOICES}`, maxItems: `${CHOICES}`, items: { type: 'NUMBER' }, description: `Exactly ${CHOICES} distinct numeric answer choices` },
          answerIndex: { type: 'INTEGER', description: 'Zero-based index of the correct choice' },
          hint: { type: 'STRING', description: 'A gentle nudge, not the answer' },
        },
        required: ['question', 'equation', 'choices', 'answerIndex', 'hint'],
      },
    },
  },
  required: ['title', 'intro', 'problems'],
};

function systemInstruction(skill, tier) {
  return `You write math missions for children ages 5-8, in the style of the
iOS game Cosmic Cadets: a warm, wonder-filled space adventure. Each mission is
a set of ${PROBLEM_COUNT} bite-sized word problems.

This mission practices: ${SKILLS[skill]}.
Difficulty tier ${tier} of 5: ${TIER_GUIDE[tier]}.

Rules:
- One short sentence per problem, concrete and visual (stars, moons, rockets,
  friendly aliens, space snacks). No violence, no scary content, no brand names.
- Exactly ${CHOICES} answer choices per problem, all distinct, all plausible
  (near the correct value). answerIndex must point at the correct one.
- The math must be exactly right — double-check each answer.
- Hints nudge ("try counting the moons one by one"), never reveal the answer.
- Vary the scenario across the ${PROBLEM_COUNT} problems; keep the mission title playful.
- Plain text only in every field — no markdown symbols.`;
}

/** Validate the model's mission; returns a list of problems (empty = valid). */
export function validateMission(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return ['mission is not an object'];
  if (!m.title?.trim()) errors.push('missing title');
  if (!m.intro?.trim()) errors.push('missing intro');
  if (!Array.isArray(m.problems) || m.problems.length !== PROBLEM_COUNT) {
    errors.push(`expected exactly ${PROBLEM_COUNT} problems`);
    return errors;
  }
  m.problems.forEach((p, i) => {
    if (!p.question?.trim()) errors.push(`problem ${i + 1}: missing question`);
    if (!Array.isArray(p.choices) || p.choices.length !== CHOICES) {
      errors.push(`problem ${i + 1}: needs exactly ${CHOICES} choices`);
      return;
    }
    if (p.choices.some((c) => typeof c !== 'number' || !Number.isFinite(c))) {
      errors.push(`problem ${i + 1}: choices must be numbers`);
    }
    if (new Set(p.choices).size !== p.choices.length) {
      errors.push(`problem ${i + 1}: choices must be distinct`);
    }
    if (!Number.isInteger(p.answerIndex) || p.answerIndex < 0 || p.answerIndex >= CHOICES) {
      errors.push(`problem ${i + 1}: answerIndex out of range`);
      return;
    }
    if (!p.hint?.trim()) errors.push(`problem ${i + 1}: missing hint`);

    // When the equation is machine-checkable, verify the marked answer is
    // actually the right math — the one failure shape must never reach a child.
    // Anything that matches neither pattern (counting/comparison prose) is
    // skipped rather than guessed at.
    const eqStr = typeof p.equation === 'string' ? p.equation : '';
    const marked = p.choices[p.answerIndex];
    const simple = /^\s*(\d+)\s*([+−\-x×*])\s*(\d+)\s*$/.exec(eqStr);
    const missing = /^\s*(\d+)\s*([+−\-])\s*[_?]\s*=\s*(\d+)\s*$/.exec(eqStr);
    if (simple) {
      const a = +simple[1], b = +simple[3];
      const op = simple[2];
      const val = op === '+' ? a + b : (op === '-' || op === '−') ? a - b : a * b;
      if (marked !== val) {
        errors.push(`problem ${i + 1}: equation "${eqStr.trim()}" = ${val} but the marked answer is ${marked}`);
      }
    } else if (missing) {
      const a = +missing[1], c = +missing[3];
      const val = missing[2] === '+' ? c - a : a - c;
      if (marked !== val) {
        errors.push(`problem ${i + 1}: the blank in "${eqStr.trim()}" is ${val} but the marked answer is ${marked}`);
      }
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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY is not set');
    err.code = 'NO_KEY';
    throw err;
  }
  const ai = new GoogleGenAI(USE_VERTEX ? { vertexai: true, apiKey } : { apiKey });

  const contents = [{ role: 'user', parts: [{ text: 'Generate the mission now.' }] }];

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
    const errors = validateMission(mission);
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
  const err = new Error('The mission generator returned invalid data twice.');
  err.code = 'BAD_MISSION';
  throw err;
}
