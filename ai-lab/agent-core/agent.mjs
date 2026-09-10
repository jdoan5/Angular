// The agent loop: Gemini plus the iTunes tools, streaming its progress as it
// works. Runs server-side only — the API key must never reach the browser.
// Shared verbatim by the Vercel function (api/agent.mjs) and the local dev
// server (dev-server.mjs).

import { toolRegistry } from './tools.mjs';
import { gameTools } from './game.mjs';
import { makeGenAI } from './client.mjs';
import { AGENTS, DEFAULT_AGENT } from './agents.mjs';

// Guess My App's tools live in game.mjs, beside the sealed state they read.
// They are merged here rather than inside tools.mjs so that module stays free
// of any dependency on game.mjs — game.mjs imports it, and a cycle would put
// this const in the temporal dead zone at module-eval time.
const registry = { ...toolRegistry, ...gameTools };

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const MAX_TOOL_ROUNDS = 6;

const NO_ANSWER =
  "I ran out of tool budget before I could finish that one — try asking something more specific.";

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
 * @param {string} agentId which agent config to run (see agents.mjs)
 * @param {Array<{role:'user'|'model', text:string}>} history prior chat turns
 * @param {string} message the new user message
 * @param {(event: object) => void} emit event sink (transport-agnostic)
 * @param {AbortSignal} [signal] stop doing work when the client disconnects
 * @param {object} [context] per-turn state handed to tools and appended to the
 *        system instruction. Guess My App uses it to hold the secret app; tools
 *        may mutate context.state, and onFinish reports the result back.
 */
export async function runAgentStream(agentId, history, message, emit, signal, context) {
  // Object.hasOwn so prototype keys ("constructor" etc.) can't resolve.
  const agent = Object.hasOwn(AGENTS, agentId ?? '') ? AGENTS[agentId] : AGENTS[DEFAULT_AGENT];
  const ai = makeGenAI();   // throws NO_KEY when credentials are missing
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

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) return;   // client is gone — stop spending quota
    const stream = await ai.models.generateContentStream({
      model: MODEL,
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: declarationsFor(agent) }],
        temperature: 0.4,
        ...(signal ? { abortSignal: signal } : {}),
      },
    });

    // Stream this round: forward text deltas immediately (they're the answer
    // in the common case) while collecting every part for the model turn.
    const allParts = [];
    const calls = [];
    let roundText = '';
    for await (const chunk of stream) {
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        allParts.push(part);
        if (part.functionCall) calls.push(part.functionCall);
        if (part.text && !part.thought) {
          roundText += part.text;
          send({ type: 'delta', text: part.text });
        }
      }
    }

    if (calls.length === 0 || round === MAX_TOOL_ROUNDS) {
      // Budget exhausted with calls still pending: whatever text streamed was
      // pre-tool chatter, not an answer — discard it and say so.
      if (calls.length > 0 && roundText.trim()) {
        send({ type: 'draft-discard' });
        roundText = '';
      }
      if (!roundText.trim()) send({ type: 'delta', text: NO_ANSWER });
      finish();
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
      const result = await executeTool(agent, call.name, call.args, context);
      send({ type: 'tool-end', tool: call.name, summary: summarize(call.name, result) });
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
  }
  // Unreachable (the final round returns above); kept as a safe fallback.
  send({ type: 'delta', text: NO_ANSWER });
  finish();
}

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
    // The trace is visible to the player, so a wrong guess must never hint at
    // the answer — it echoes only what they themselves typed.
    case 'check_guess':
      return result.correct
        ? `correct — ${result.appName}`
        : `"${String(result.guessed ?? '').slice(0, 60)}" is not it · ${result.questionsLeft ?? 0} questions left`;
    case 'give_up':
      return `revealed — ${result.appName}`;
    default:
      return 'done';
  }
}
