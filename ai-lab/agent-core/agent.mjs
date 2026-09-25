// The agent loop: Gemini plus the iTunes tools, streaming its progress as it
// works. Runs server-side only — the API key must never reach the browser.
// Shared verbatim by the Vercel function (api/agent.mjs) and the local dev
// server (dev-server.mjs).

import { FinishReason, ThinkingLevel } from '@google/genai';
import { toolRegistry } from './tools.mjs';
import { gameTools } from './game.mjs';
import { radarTools, TRACKED } from './radar.mjs';
import { makeGenAI } from './client.mjs';
import { AGENTS, DEFAULT_AGENT } from './agents.mjs';

// Guess My App's tools live in game.mjs, beside the sealed state they read.
// They are merged here rather than inside tools.mjs so that module stays free
// of any dependency on game.mjs — game.mjs imports it, and a cycle would put
// this const in the temporal dead zone at module-eval time. The Review Radar
// tools join here for the same reason: radar.mjs imports tools.mjs.
const registry = { ...toolRegistry, ...gameTools, ...radarTools };

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

// Cost ceilings for one visitor message, all paid from John's key. Before
// these, one request could run six tool rounds with unlimited parallel calls
// in each, with output and thinking uncapped.
const MAX_TOOL_ROUNDS = 4;
// list_my_apps plus get_app_details on every one of the 15 apps.
const MAX_CALLS_PER_TURN = 16;
// Every round re-sends all prior tool output; past this the turn is mostly
// paying to re-read results, so stop instead of growing it further.
const MAX_CONTENTS_CHARS = 150_000;
// Headroom, not a length target. genai.d.ts reports thoughtsTokenCount apart
// from candidatesTokenCount but never says whether thinking is carved out of
// this cap, so assume it is: LOW thinking must not starve the visible answer.
const MAX_OUTPUT_TOKENS = 4096;

const NO_ANSWER =
  "I ran out of tool budget before I could finish that one — try asking something more specific.";
const CALL_BUDGET_ERROR = 'tool budget for this turn is used up';

// Finish reasons that mean a filter withheld the output, as opposed to the
// model simply producing nothing.
const FILTERED = new Set([
  FinishReason.SAFETY, FinishReason.PROHIBITED_CONTENT, FinishReason.BLOCKLIST,
  FinishReason.SPII, FinishReason.RECITATION,
]);
// The model tried to call a tool and produced something unusable. Usually a
// one-off, so the round earns a single retry.
const BROKEN_CALL = new Set([FinishReason.MALFORMED_FUNCTION_CALL, FinishReason.UNEXPECTED_TOOL_CALL]);
// The only ends that leave streamed text standing as the answer. MAX_TOKENS
// is a cut, but the text is still the model's own reply. Anything else (a
// filter mid-answer, chatter before a broken call, LANGUAGE, OTHER) used to
// be kept too, and was then charged and replayed as a real answer.
const ANSWER_ENDS = new Set([
  undefined, FinishReason.FINISH_REASON_UNSPECIFIED, FinishReason.STOP, FinishReason.MAX_TOKENS,
]);

/** A round that ends without an answer: nothing at all, a broken call, or a
 *  filter cut. The message is shown to the visitor verbatim (api/agent.mjs
 *  passes EMPTY_ROUND through), so it names no internals; the raw reasons
 *  ride along for the server log. */
function emptyRoundError({ finishReason, blockReason }) {
  const filtered = Boolean(blockReason) || FILTERED.has(finishReason);
  const err = new Error(
    filtered
      ? 'The model declined to answer that one. Try rephrasing your question.'
      : 'The model came back without an answer. Please try again.'
  );
  return Object.assign(err, { code: 'EMPTY_ROUND', finishReason, blockReason });
}

function declarationsFor(agent) {
  return agent.tools
    .filter((name) => registry[name])
    .map((name) => {
      const t = registry[name];
      return {
        name,
        description: t.description,
        ...(t.parameters ? { parameters: t.parameters } : {}),
      };
    });
}

async function executeTool(agent, name, args, context) {
  // Tools are scoped per agent: even if the model invents a name from another
  // agent's kit, it stays unavailable here.
  const tool = agent.tools.includes(name) ? registry[name] : undefined;
  if (!tool) return { error: `Unknown tool: ${name}` };
  try {
    return await tool.fn(args ?? {}, context);
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

/**
 * Run one agent turn, streaming progress through `emit(event)`:
 *   {type:'tool-start', tool, args}     a tool call is about to run
 *   {type:'tool-end',   tool, summary}  it finished (one line for the trace)
 *   {type:'delta',      text}           a chunk of the answer text
 *   {type:'draft-discard'}              discard deltas streamed so far this turn
 *                                       (the round turned out to be a tool round)
 *   {type:'done',       model}          turn complete
 *
 * A round that ends without an answer (empty, filtered, a broken call) throws
 * an Error with code EMPTY_ROUND instead: no 'done', and onFinish does not run,
 * so a Guess round is not charged a question for an answer that never came.
 * The one exception is a round a tool already ended this turn (give_up, a
 * correct guess): onFinish still runs so the finished round is sealed.
 *
 * @param {string} agentId which agent config to run (see agents.mjs)
 * @param {Array<{role:'user'|'model', text:string}>} history prior chat turns
 * @param {string} message the new user message
 * @param {(event: object) => void} emit event sink (transport-agnostic)
 * @param {AbortSignal} [signal] stop doing work when the client disconnects
 * @param {object} [context] per-turn state handed to tools and appended to the
 *        system instruction. Guess My App uses it to hold the secret app; tools
 *        may mutate context.state, and onFinish reports the result back.
 * @param {{ai?: object}} [deps] test seam: a stand-in for the GenAI client
 */
export async function runAgentStream(agentId, history, message, emit, signal, context, { ai } = {}) {
  // Object.hasOwn so prototype keys ("constructor" etc.) can't resolve.
  const agent = Object.hasOwn(AGENTS, agentId ?? '') ? AGENTS[agentId] : AGENTS[DEFAULT_AGENT];
  const client = ai ?? makeGenAI();   // throws NO_KEY when credentials are missing
  const send = (event) => { if (!signal?.aborted) emit(event); };

  // Per-turn facts (e.g. the redacted fact sheet) ride along with the agent's
  // static prompt — they must never be persisted into the chat history, which
  // the browser holds and could read.
  const systemInstruction = context?.systemSuffix
    ? `${agent.systemInstruction}\n${context.systemSuffix}`
    : agent.systemInstruction;

  // Let the caller emit closing events (a refreshed game token) before 'done'.
  const finish = () => {
    context?.onFinish?.(send);
    send({ type: 'done', model: MODEL });
  };

  // Defensive re-filter (the API layer validates too): only well-formed,
  // non-empty turns may enter contents — Vertex rejects empty text parts.
  const contents = [
    ...(history ?? [])
      .filter((t) => (t?.role === 'user' || t?.role === 'model') &&
                     typeof t?.text === 'string' && t.text.trim())
      .map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: 'user', parts: [{ text: message }] },
  ];

  // Stream one model round: forward text deltas immediately (they're the
  // answer in the common case) while collecting every part for the model turn.
  const streamRound = async () => {
    const stream = await client.models.generateContentStream({
      model: MODEL,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: declarationsFor(agent) }],
        temperature: 0.4,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // thinkingLevel, not thinkingBudget: genai.d.ts (tuning config) says
        // Gemini 3.5 rejects thinking_budget as a user error; LOW keeps
        // thinking cheap. No includeThoughts — thought text must never be
        // streamed to the visitor.
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        ...(signal ? { abortSignal: signal } : {}),
      },
    });
    const r = { allParts: [], calls: [], text: '', finishReason: undefined, blockReason: undefined };
    for await (const chunk of stream) {
      // A blocked prompt arrives as promptFeedback on the first chunk with no
      // candidates at all; reading only parts made it look like a quiet reply.
      r.blockReason ??= chunk.promptFeedback?.blockReason;
      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) r.finishReason = candidate.finishReason;
      for (const part of candidate?.content?.parts ?? []) {
        r.allParts.push(part);
        if (part.functionCall) r.calls.push(part.functionCall);
        if (part.text && !part.thought) {
          r.text += part.text;
          send({ type: 'delta', text: part.text });
        }
      }
    }
    return r;
  };

  let callsLeft = MAX_CALLS_PER_TURN;
  let retriedBrokenCall = false;
  const wasOver = context?.state?.over === true;

  // Stopping on the turn's budget is not an answer, so a Guess round is not
  // charged a question for it (finish() would seal asked+1). The exception is
  // a round a tool already ended this turn — a correct guess or give_up —
  // which must be sealed, or the browser keeps playing a finished round.
  const budgetStop = () => {
    send({ type: 'delta', text: NO_ANSWER });
    if (!wasOver && context?.state?.over === true) context.onFinish?.(send);
    send({ type: 'done', model: MODEL });
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) return;   // client is gone — stop spending quota

    let r;
    try {
      for (;;) {
        r = await streamRound();
        if (signal?.aborted) return;
        if (r.calls.length) break;
        if (r.text.trim() && !r.blockReason && ANSWER_ENDS.has(r.finishReason)) break;
        // Not an answer. An empty round used to fall through to the no-calls
        // branch: it streamed NO_ANSWER even on round 0 and ran onFinish, so
        // a safety block was sealed into the Guess token as an answered
        // question. Whatever did stream (pre-call chatter, a half answer a
        // filter cut) is withdrawn before the retry or the error.
        if (r.text) send({ type: 'draft-discard' });
        if (BROKEN_CALL.has(r.finishReason) && !retriedBrokenCall) {
          retriedBrokenCall = true;
          console.warn(`agent: round ${round} ended with ${r.finishReason}; retrying once`);
          continue;
        }
        throw emptyRoundError(r);
      }
    } catch (err) {
      // A give_up or correct guess earlier this turn already put the name in
      // the trace. Dropping the re-sealed token left the browser playing a
      // round that was over, and it could "win" it next turn with the name
      // it had just been shown. Seal it; still no 'done'.
      if (!wasOver && context?.state?.over === true) context.onFinish?.(send);
      throw err;
    }
    if (r.finishReason && r.finishReason !== FinishReason.STOP) {
      // e.g. MAX_TOKENS mid-answer: the partial text is still worth showing.
      console.warn(`agent: round ${round} ended with ${r.finishReason}; keeping the partial output`);
    }

    const { allParts, calls } = r;
    let roundText = r.text;

    // No calls: the empty-round guard above means there is real text, so
    // this is the answer.
    if (calls.length === 0) {
      finish();
      return;
    }
    if (round === MAX_TOOL_ROUNDS) {
      // Budget exhausted with calls still pending: whatever text streamed was
      // pre-tool chatter, not an answer — discard it and say so.
      if (roundText.trim()) send({ type: 'draft-discard' });
      budgetStop();
      return;
    }

    // Tool round after all — any deltas we optimistically streamed were
    // pre-tool chatter, not the final answer; tell the client to reset.
    if (roundText.trim()) send({ type: 'draft-discard' });

    contents.push({ role: 'model', parts: allParts });

    const responseParts = [];
    for (const call of calls) {
      if (signal?.aborted) return;
      send({ type: 'tool-start', tool: call.name, args: call.args ?? {} });
      let result, summary;
      if (callsLeft > 0) {
        callsLeft--;
        result = await executeTool(agent, call.name, call.args, context);
        summary = summarize(call.name, result);
      } else {
        // Over budget: every functionCall still needs its functionResponse,
        // but the tool does not run, and the trace says so rather than
        // passing it off as a tool failure.
        result = { error: CALL_BUDGET_ERROR };
        summary = `skipped: ${CALL_BUDGET_ERROR}`;
      }
      send({ type: 'tool-end', tool: call.name, summary });
      responseParts.push({
        functionResponse: {
          // Echo the call id when the API populates one (parallel-call contract).
          ...(call.id ? { id: call.id } : {}),
          name: call.name,
          response: { result },
        },
      });
    }
    contents.push({ role: 'user', parts: responseParts });

    // Tools already ran and a guess may have ended the round; budgetStop()
    // seals that case and charges nothing otherwise.
    if (JSON.stringify(contents).length > MAX_CONTENTS_CHARS) {
      console.warn(`agent: contents passed ${MAX_CONTENTS_CHARS} chars after round ${round}; stopping`);
      budgetStop();
      return;
    }
  }
  // Unreachable (the final round returns above); kept as a safe fallback.
  budgetStop();
}

// "Finch: 13 versions", not "Finch: Self-Care Pet: 13 versions".
const shortName = (app) => (typeof app === 'string' && Object.hasOwn(TRACKED, app) ? TRACKED[app].short : String(app ?? '?'));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const radarSource = (r) =>
  ` · gold snapshot, as of ${r.as_of}${r.stale ? ' (stale)' : ''}${r.fetch_error ? ' (last good copy)' : ''}`;
// An app whose reviews stop weeks before the export says so in the trace,
// or "as of Sept 24" reads as current for Atoms data that ends July 29.
const reach = (r) => {
  const gap = (Date.parse(r.as_of) - Date.parse(r.newest_review_at)) / 86_400_000;
  return gap >= 14 ? `, reviews to ${r.newest_review_at}` : '';
};

/** One-line human summary of a tool result for the UI trace. */
function summarize(name, result) {
  if (result?.error) return `error: ${result.error}`;
  switch (name) {
    case 'list_my_apps':
      return `${result.count} apps found`;
    case 'get_app_details':
      return `${result.name ?? '?'} — ${result.averageRating ?? '–'}★ (${result.ratingCount ?? 0} ratings), v${result.version ?? '?'}`;
    case 'get_app_reviews':
      return `${result.count} reviews fetched (${result.sort}, ${result.country})`;
    case 'get_developer_profile':
      return 'profile loaded';
    // Snapshot answers name their source and date in the trace, so a visitor
    // can tell lakehouse numbers from live ones, and an old copy says so.
    case 'get_market_overview':
      return `${result.apps?.length ?? 0} apps, ${result.total_reviews ?? 0} reviews${result.store_error ? ' (store ratings unavailable)' : ''}${radarSource(result)}`;
    case 'get_version_ratings': {
      const d = result.biggest_drop;
      // A drop across years of releases is a different claim from one update.
      const apart = d?.gap_days > 90 ? `, ${d.gap_days} days apart` : '';
      const drop = d ? `, biggest drop ${d.from} → ${d.to} ${d.delta} (n=${d.n_from}→${d.n_to}${apart})` : '';
      return `${shortName(result.app)}: ${plural(result.versions?.length ?? 0, 'version')}${drop}${reach(result)}${radarSource(result)}`;
    }
    case 'get_rating_trend': {
      const { recent: r, prior: p } = result;
      const body = result.enough_data
        ? `last ${result.weeks} wk ${r.avg} (n=${r.n}) vs prior ${p.avg} (n=${p.n}), ${result.delta > 0 ? '+' : ''}${result.delta}`
        : `not enough data for ${/^(8|11|18)$/.test(String(result.weeks)) ? 'an' : 'a'} ${result.weeks}-week trend`;
      return `${shortName(result.app)}: ${body}${reach(result)}${radarSource(result)}`;
    }
    case 'get_competitor_reviews':
      return `${shortName(result.app)}: ${plural(result.count, 'review')}, page ${result.page}`
        + `${result.max_rating ? `, ≤${result.max_rating}★` : ''}${result.sort === 'mostHelpful' ? ', most helpful' : ''}`
        + `${result.empty_note ? ' (feed came back empty)' : ''}${result.match_note ? ' (none matched on this page)' : ''}`
        + ' · live App Store RSS';
    // The trace is visible to the player, so a wrong guess must never hint at
    // the answer — it echoes only what they themselves typed.
    case 'check_guess':
      if (result.correct) return `correct — ${result.appName}`;
      // Not a catalog name at all: it isn't judged or counted, so the trace
      // must not read like a wrong guess ("is not it · 17 left").
      if (result.recognized === false) {
        return `"${String(result.guessed ?? '').slice(0, 60)}" is not one of John's apps · not counted`;
      }
      return `"${String(result.guessed ?? '').slice(0, 60)}" is not it · ${result.questionsLeft ?? 0} questions left`;
    case 'give_up':
      return `revealed — ${result.appName}`;
    default:
      return 'done';
  }
}
