// API guard + agent loop regression suite — no network, no Gemini.
//   node --test agent-core/api.test.mjs
//
// The handlers are driven with credentials unset, so every request that gets
// past the guards stops at the 503 credential gate before any model call. The
// loop tests inject a scripted stand-in for the GenAI client instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import agentHandler, { sanitizeHistory, historyForTurn, visitorError } from '../api/agent.mjs';
import missionHandler from '../api/mission.mjs';
import { runAgentStream } from './agent.mjs';
import { seal, unseal } from './game.mjs';

// Read lazily by client.mjs, so clearing them here is early enough.
for (const k of ['GEMINI_API_KEY', 'GEMINI_AUTH', 'GEMINI_VERTEX', 'GOOGLE_CLOUD_PROJECT']) {
  delete process.env[k];
}

// ------------------------------------------------------------------ helpers

// The in-memory limiter allows 8/min per IP, so every call gets its own.
let ipSeq = 0;
const nextIp = () => `203.0.113.${++ipSeq}`;

function mockReq({ method = 'POST', headers = {}, body, ip = nextIp() } = {}) {
  return { method, headers: { 'x-forwarded-for': ip, ...headers }, body, socket: {} };
}

function mockRes() {
  const res = new EventEmitter();
  Object.assign(res, { statusCode: 200, body: undefined, chunks: [], headers: {}, writableEnded: false });
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; res.writableEnded = true; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.write = (s) => { res.chunks.push(s); return true; };
  res.end = () => { res.writableEnded = true; };
  return res;
}

async function call(handler, opts) {
  const res = mockRes();
  await handler(mockReq(opts), res);
  return res;
}

const JSON_TYPE = { 'content-type': 'application/json' };
const ENDPOINTS = [
  ['agent', agentHandler, { agent: 'reviews', message: 'How is Toehold rated?' }],
  ['mission', missionHandler, { skill: 'addition', tier: 1 }],
];

/** A scripted GenAI client. `script` is a list of rounds (each a list of
 *  chunks) or a function (roundIndex) => chunks. Records every request. */
function fakeAI(script) {
  const requests = [];
  return {
    requests,
    models: {
      async generateContentStream(params) {
        const i = requests.length;
        // Snapshot: the loop keeps pushing to the same contents array.
        requests.push({ contents: structuredClone(params.contents), config: { ...params.config } });
        const chunks = typeof script === 'function' ? script(i) : script[i];
        if (!chunks) throw new Error(`unexpected model call #${i}`);
        return (async function* () { yield* chunks; })();
      },
    },
  };
}

const chunk = (parts, finishReason) => ({
  candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
});
const fnCall = (name, id, args = {}) => ({ functionCall: { name, args, ...(id ? { id } : {}) } });
const text = (t) => ({ text: t });

/** Run one turn; resolves to the events plus the error, if it threw. */
async function runTurn({ agent = 'concierge', history = [], message = 'hi', context, ai }) {
  const events = [];
  let error = null;
  try {
    await runAgentStream(agent, history, message, (e) => events.push(e), undefined, context, { ai });
  } catch (err) {
    error = err;
  }
  return { events, error, of: (type) => events.filter((e) => e.type === type) };
}

/** A Guess-shaped context whose onFinish is observable. */
function gameCtx() {
  const ctx = {
    state: { appId: 1, name: 'Secret App', url: '', asked: 3, over: false },
    systemSuffix: '\nSECRET APP FACT SHEET: (test)',
    finished: 0,
    onFinish: (send) => {
      ctx.finished++;
      send({ type: 'game', token: 'sealed', asked: 3, remaining: 17, over: ctx.state.over === true });
    },
  };
  return ctx;
}

const NO_ANSWER_RE = /ran out of tool budget/;

// ---------------------------------------------------------- H1: request guard

for (const [name, handler, body] of ENDPOINTS) {
  test(`${name}: form-encoded POST is refused with 415`, async () => {
    const res = await call(handler, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      // What Vercel would have parsed out of `agent=reviews&message=...`.
      body,
    });
    assert.equal(res.statusCode, 415);
    assert.deepEqual(res.body, { error: 'JSON only' });
  });

  test(`${name}: missing content-type is refused with 415`, async () => {
    const res = await call(handler, { body });
    assert.equal(res.statusCode, 415);
  });

  test(`${name}: text/plain (the other no-preflight type) is refused with 415`, async () => {
    const res = await call(handler, { headers: { 'content-type': 'text/plain;charset=UTF-8' }, body });
    assert.equal(res.statusCode, 415);
  });

  for (const site of ['cross-site', 'same-site']) {
    test(`${name}: Sec-Fetch-Site ${site} is refused with 403`, async () => {
      const res = await call(handler, { headers: { ...JSON_TYPE, 'sec-fetch-site': site }, body });
      assert.equal(res.statusCode, 403);
      assert.deepEqual(res.body, { error: 'cross-site request' });
    });
  }

  test(`${name}: same-origin JSON reaches the credential gate (503)`, async () => {
    const res = await call(handler, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'sec-fetch-site': 'same-origin' },
      body,
    });
    assert.equal(res.statusCode, 503);
  });

  test(`${name}: JSON without Sec-Fetch-Site (curl, servers) reaches the credential gate (503)`, async () => {
    const res = await call(handler, { headers: JSON_TYPE, body });
    assert.equal(res.statusCode, 503);
  });

  test(`${name}: refused requests do not spend the visitor's rate limit`, async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i++) {
      const res = await call(handler, { ip, headers: { ...JSON_TYPE, 'sec-fetch-site': 'cross-site' }, body });
      assert.equal(res.statusCode, 403);
    }
    const res = await call(handler, { ip, headers: { ...JSON_TYPE, 'sec-fetch-site': 'same-origin' }, body });
    assert.equal(res.statusCode, 503);
  });
}

test('agent: GET health still answers 200 with no content-type', async () => {
  const res = await call(agentHandler, { method: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.hasKey, false);
});

test('mission: GET is still 405', async () => {
  const res = await call(missionHandler, { method: 'GET' });
  assert.equal(res.statusCode, 405);
});

// ------------------------------------------------------ H2: loop cost ceilings

test('20 calls in one round: exactly 16 run, 4 get the budget error', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
  const ai = fakeAI([
    [chunk(ids.map((id) => fnCall('get_developer_profile', id)))],
    [chunk([text('Here is John.')], 'STOP')],
  ]);
  const { error, of } = await runTurn({ ai });
  assert.equal(error, null);

  const ends = of('tool-end');
  assert.equal(of('tool-start').length, 20, 'every requested call shows in the trace');
  assert.equal(ends.filter((e) => e.summary === 'profile loaded').length, 16);
  const skipped = ends.filter((e) => /tool budget for this turn is used up/.test(e.summary));
  assert.equal(skipped.length, 4);
  assert.ok(skipped.every((e) => e.summary.startsWith('skipped')), 'trace says skipped, not failed');

  // The model gets one functionResponse per call, ids echoed, 4 of them errors.
  const responses = ai.requests[1].contents.at(-1).parts.map((p) => p.functionResponse);
  assert.equal(responses.length, 20);
  assert.deepEqual(responses.map((r) => r.id), ids);
  const errored = responses.filter((r) => r.response.result.error === 'tool budget for this turn is used up');
  assert.equal(errored.length, 4);
  assert.deepEqual(errored.map((r) => r.id), ['c16', 'c17', 'c18', 'c19']);
  assert.equal(of('done').length, 1);
});

test('the call budget spans rounds, not just one', async () => {
  const ai = fakeAI([
    [chunk(Array.from({ length: 10 }, () => fnCall('get_developer_profile')))],
    [chunk(Array.from({ length: 10 }, () => fnCall('get_developer_profile')))],
    [chunk([text('Done.')], 'STOP')],
  ]);
  const { error, of } = await runTurn({ ai });
  assert.equal(error, null);
  const ends = of('tool-end');
  assert.equal(ends.filter((e) => e.summary === 'profile loaded').length, 16);
  assert.equal(ends.filter((e) => e.summary.startsWith('skipped')).length, 4);
});

test('round cap: 4 tool rounds, then the budget-exhausted answer', async () => {
  // A model that never stops asking for tools.
  const ai = fakeAI(() => [chunk([fnCall('get_developer_profile')])]);
  const ctx = gameCtx();
  const { error, of } = await runTurn({ ai, context: ctx });
  assert.equal(error, null);
  assert.equal(of('tool-start').length, 4, 'tools run in 4 rounds');
  assert.equal(ai.requests.length, 5, '4 tool rounds + the final round whose calls are dropped');
  assert.match(of('delta').map((e) => e.text).join(''), NO_ANSWER_RE);
  assert.equal(of('done').length, 1);
  assert.equal(ctx.finished, 1, 'a genuine budget stop still carries the round forward');
});

test('generation config caps output and sets a thinking level (no budget, no thoughts)', async () => {
  const ai = fakeAI([[chunk([text('Hi!')], 'STOP')]]);
  await runTurn({ ai });
  const { config } = ai.requests[0];
  assert.equal(config.maxOutputTokens, 4096);
  assert.deepEqual(config.thinkingConfig, { thinkingLevel: 'LOW' });
});

test('contents past ~150k chars stops the loop before another model call', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const ai = fakeAI([[chunk([fnCall('get_developer_profile')])]]);
  const history = [{ role: 'user', text: 'x'.repeat(150_000) }, { role: 'model', text: 'ok' }];
  const { error, of } = await runTurn({ ai, history });
  assert.equal(error, null);
  assert.equal(ai.requests.length, 1);
  assert.match(of('delta').map((e) => e.text).join(''), NO_ANSWER_RE);
  assert.equal(of('done').length, 1);
});

// ------------------------------------------------- H4: empty / blocked rounds

test('an empty SAFETY round throws; no done, no onFinish, no fake answer', async () => {
  const ai = fakeAI([[chunk([], 'SAFETY')]]);
  const ctx = gameCtx();
  const { error, events, of } = await runTurn({ agent: 'guess', ai, context: ctx });
  assert.ok(error, 'the turn fails');
  assert.equal(error.code, 'EMPTY_ROUND');
  assert.equal(error.finishReason, 'SAFETY');
  assert.doesNotMatch(error.message, /SAFETY|finish/i, 'visitor-safe message');
  assert.equal(of('done').length, 0);
  assert.equal(of('game').length, 0);
  assert.equal(ctx.finished, 0, 'the question must not be charged');
  assert.ok(!events.some((e) => e.type === 'delta' && NO_ANSWER_RE.test(e.text)));
});

test('a prompt blocked via promptFeedback throws EMPTY_ROUND', async () => {
  const ai = fakeAI([[{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }]]);
  const ctx = gameCtx();
  const { error, of } = await runTurn({ agent: 'guess', ai, context: ctx });
  assert.equal(error?.code, 'EMPTY_ROUND');
  assert.equal(error.blockReason, 'PROHIBITED_CONTENT');
  assert.equal(of('done').length, 0);
  assert.equal(ctx.finished, 0);
});

test('an empty STOP round on round 0 is an error, not "ran out of tool budget"', async () => {
  const ai = fakeAI([[chunk([], 'STOP')]]);
  const { error, of } = await runTurn({ ai });
  assert.equal(error?.code, 'EMPTY_ROUND');
  assert.equal(of('delta').length, 0);
  assert.equal(of('done').length, 0);
});

test('MALFORMED_FUNCTION_CALL retries the round once, then succeeds', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const ai = fakeAI([
    [chunk([], 'MALFORMED_FUNCTION_CALL')],
    [chunk([text('Yes, it is a game.')], 'STOP')],
  ]);
  const ctx = gameCtx();
  const { error, of } = await runTurn({ agent: 'guess', ai, context: ctx });
  assert.equal(error, null);
  assert.equal(ai.requests.length, 2);
  assert.deepEqual(ai.requests[1].contents, ai.requests[0].contents, 'the same round is re-asked');
  assert.equal(of('delta').map((e) => e.text).join(''), 'Yes, it is a game.');
  assert.equal(of('done').length, 1);
  assert.equal(ctx.finished, 1);
  assert.equal(warn.mock.callCount(), 1);
});

test('MALFORMED_FUNCTION_CALL twice gives up after one retry', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const ai = fakeAI(() => [chunk([], 'MALFORMED_FUNCTION_CALL')]);
  const ctx = gameCtx();
  const { error, of } = await runTurn({ agent: 'guess', ai, context: ctx });
  assert.equal(error?.code, 'EMPTY_ROUND');
  assert.equal(ai.requests.length, 2);
  assert.equal(of('done').length, 0);
  assert.equal(ctx.finished, 0);
});

test('MAX_TOKENS with partial text keeps the text and warns', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const ai = fakeAI([[chunk([text('Toehold teaches sudoku by')]), chunk([], 'MAX_TOKENS')]]);
  const { error, of } = await runTurn({ ai });
  assert.equal(error, null);
  assert.equal(of('delta').map((e) => e.text).join(''), 'Toehold teaches sudoku by');
  assert.equal(of('done').length, 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /MAX_TOKENS/);
});

for (const reason of ['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL']) {
  test(`${reason} after chatter: the chatter is withdrawn and the round retried`, async (t) => {
    t.mock.method(console, 'warn', () => {});
    const ai = fakeAI([
      [chunk([text('Let me check the facts.')], reason)],
      [chunk([text('Yes.')], 'STOP')],
    ]);
    const ctx = gameCtx();
    const { error, events } = await runTurn({ agent: 'guess', ai, context: ctx });
    assert.equal(error, null);
    assert.equal(ai.requests.length, 2, 'the broken round is re-asked, not taken as the answer');
    assert.deepEqual(
      events.map((e) => (e.type === 'delta' ? `delta:${e.text}` : e.type)),
      ['delta:Let me check the facts.', 'draft-discard', 'delta:Yes.', 'game', 'done']
    );
    assert.equal(ctx.finished, 1);
  });
}

for (const reason of ['SAFETY', 'RECITATION', 'OTHER']) {
  test(`${reason} mid-answer: the half answer is withdrawn and the turn fails`, async () => {
    const ai = fakeAI([[chunk([text('It is a puz')]), chunk([], reason)]]);
    const ctx = gameCtx();
    const { error, events, of } = await runTurn({ agent: 'guess', ai, context: ctx });
    assert.equal(error?.code, 'EMPTY_ROUND');
    assert.equal(error.finishReason, reason);
    assert.deepEqual(events.map((e) => e.type), ['delta', 'draft-discard']);
    assert.equal(of('done').length, 0);
    assert.equal(ctx.finished, 0, 'a cut answer is not charged or replayed');
  });
}

test('give_up, then a blocked round: the finished round is still sealed (no done)', async () => {
  const ai = fakeAI([
    [chunk([fnCall('give_up')])],
    [chunk([], 'SAFETY')],
  ]);
  const ctx = gameCtx();
  ctx.state.name = 'Toehold';
  const { error, events, of } = await runTurn({ agent: 'guess', ai, context: ctx });
  assert.equal(error?.code, 'EMPTY_ROUND');
  assert.equal(of('tool-end')[0].summary, 'revealed — Toehold');
  assert.equal(ctx.finished, 1, 'the browser must learn the round is over');
  assert.deepEqual(of('game').map((e) => e.over), [true]);
  assert.equal(of('done').length, 0);
  assert.deepEqual(events.map((e) => e.type), ['tool-start', 'tool-end', 'game']);
});

test('give_up, then a transport error: the finished round is still sealed', async () => {
  const boom = Object.assign(new Error('socket hang up'), { status: 503 });
  const ai = fakeAI((i) => { if (i === 0) return [chunk([fnCall('give_up')])]; throw boom; });
  const ctx = gameCtx();
  const { error, of } = await runTurn({ agent: 'guess', ai, context: ctx });
  assert.equal(error, boom, 'the original error still reaches the API layer');
  assert.equal(ctx.finished, 1);
  assert.equal(of('done').length, 0);
});

test('a failed turn that did not end the round seals nothing', async () => {
  const ai = fakeAI([
    [chunk([fnCall('get_developer_profile')])],
    [chunk([], 'SAFETY')],
  ]);
  const ctx = gameCtx();
  const { error, of } = await runTurn({ ai, context: ctx });
  assert.equal(error?.code, 'EMPTY_ROUND');
  assert.equal(ctx.state.over, false);
  assert.equal(ctx.finished, 0);
  assert.equal(of('game').length, 0);
});

test('visitorError: EMPTY_ROUND text passes through, everything else stays generic', () => {
  const empty = Object.assign(new Error('The model declined to answer that one.'), { code: 'EMPTY_ROUND' });
  assert.equal(visitorError(empty), empty.message);
  assert.equal(visitorError(new Error('ECONNRESET at 10.0.0.3:443')), 'Agent request failed.');
  assert.equal(visitorError(Object.assign(new Error('x'), { code: 'NO_KEY' })), 'Agent request failed.');
  assert.match(visitorError({ status: 429 }), /quota/);
  assert.equal(visitorError(undefined), 'Agent request failed.');
});

test('the 6-argument call still builds the real client (NO_KEY without credentials)', async () => {
  await assert.rejects(
    runAgentStream('concierge', [], 'hi', () => {}, undefined, undefined),
    (err) => err.code === 'NO_KEY'
  );
});

// ------------------------------------------------------ history caps and H3

const pairs = (n, len) =>
  Array.from({ length: n }, (_, i) => [
    { role: 'user', text: `q${i} `.padEnd(len, 'u') },
    { role: 'model', text: `a${i} `.padEnd(len, 'm') },
  ]).flat();

const alternates = (turns) => turns.every((t, i) => t.role === (i % 2 === 0 ? 'user' : 'model'));

test('sanitizeHistory: the total cap drops the oldest pairs and keeps alternation', () => {
  const input = pairs(10, 1500);   // 20 turns, 30k chars
  const out = sanitizeHistory(input);
  const total = out.reduce((n, t) => n + t.text.length, 0);
  assert.ok(total <= 16_000, `total ${total} is within the cap`);
  assert.equal(out.length, 10, 'five newest pairs survive');
  assert.equal(out[0].role, 'user');
  assert.ok(alternates(out));
  assert.deepEqual(out, input.slice(-10), 'newest turns kept, untouched');
});

test('sanitizeHistory: never opens on a model turn after the count cap', () => {
  // 21 turns ending on a user turn: the last-20 slice starts on a reply.
  const input = [...pairs(10, 10), { role: 'user', text: 'dangling' }];
  assert.equal(input.slice(-20)[0].role, 'model', 'precondition');
  const out = sanitizeHistory(input);
  assert.equal(out[0].role, 'user');
  assert.ok(alternates(out));
  assert.equal(out.length, 19);
});

test('sanitizeHistory: per-turn cap and filtering still apply', () => {
  const out = sanitizeHistory([
    { role: 'user', text: 'u'.repeat(5000) },
    { role: 'system', text: 'nope' },
    { role: 'model', text: '   ' },
    { role: 'model', text: 'fine' },
  ]);
  assert.deepEqual(out.map((t) => [t.role, t.text.length]), [['user', 2000], ['model', 4]]);
});

test('historyForTurn: a freshly dealt Guess round sees no earlier turns', () => {
  const history = [
    { role: 'user', text: 'I give up' },
    { role: 'model', text: 'It was Toehold!' },
  ];
  assert.deepEqual(historyForTurn(history, { fresh: true, state: {} }), []);
});

test('historyForTurn: a round in progress sees only its own turns', () => {
  const history = [
    { role: 'user', text: 'I give up' },
    { role: 'model', text: 'It was Toehold!' },
    { role: 'user', text: 'Is it a game?' },
    { role: 'model', text: 'Yes!' },
  ];
  const out = historyForTurn(history, { fresh: false, state: { historyStart: 2 } });
  assert.deepEqual(out.map((t) => t.text), ['Is it a game?', 'Yes!']);
});

// The state above is hand-built; this one goes through the real token. From
// question 2 on, historyStart only exists if unseal() keeps it — it once
// dropped the field, and the old round's reveal rode along again.
test('historyForTurn: historyStart survives a real seal/unseal round trip', () => {
  const resealed = unseal(seal({ appId: 1, name: 'Toehold', url: '', asked: 2, over: false, historyStart: 2 }));
  const history = [
    { role: 'user', text: 'I give up' },
    { role: 'model', text: 'It was Toehold!' },
    { role: 'user', text: 'Is it a game?' },
    { role: 'model', text: 'Yes!' },
  ];
  const out = historyForTurn(history, { fresh: false, state: resealed });
  assert.deepEqual(out.map((t) => t.text), ['Is it a game?', 'Yes!']);
});

test('historyForTurn: other agents get the full sanitized history', () => {
  const history = pairs(2, 5);
  assert.deepEqual(historyForTurn(history, undefined), sanitizeHistory(history));
});
