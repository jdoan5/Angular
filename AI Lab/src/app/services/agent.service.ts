import { Injectable, WritableSignal, signal } from '@angular/core';

export interface ToolTraceStep {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  running?: boolean;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  trace?: ToolTraceStep[];
  pending?: boolean;
  error?: boolean;
}

/** Chat state for one agent (each lab stage keeps its own conversation). */
export interface AgentChatState {
  messages: WritableSignal<ChatMessage[]>;
  busy: WritableSignal<boolean>;
  model: WritableSignal<string>;
}

type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'draft-discard' }
  | { type: 'tool-start'; tool: string; args: Record<string, unknown> }
  | { type: 'tool-end'; tool: string; summary: string }
  | { type: 'done'; model: string }
  | { type: 'error'; error: string };

/** Talks to the server-side agents (POST /api/agent, NDJSON streaming). The
 *  Gemini key never reaches the browser — this service only ever sees events. */
@Injectable({ providedIn: 'root' })
export class AgentService {
  readonly configured = signal<boolean | null>(null);
  private readonly states = new Map<string, AgentChatState>();

  state(agentId: string): AgentChatState {
    let s = this.states.get(agentId);
    if (!s) {
      s = { messages: signal<ChatMessage[]>([]), busy: signal(false), model: signal('') };
      this.states.set(agentId, s);
    }
    return s;
  }

  async checkHealth(): Promise<void> {
    try {
      const res = await fetch('/api/agent');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.configured.set(Boolean(data.hasKey));
    } catch {
      this.configured.set(false);
    }
  }

  async send(agentId: string, message: string): Promise<void> {
    const s = this.state(agentId);
    const text = message.trim();
    if (!text || s.busy()) return;

    const history = this.buildHistory(s);

    s.messages.update((m) => [
      ...m,
      { role: 'user', text },
      { role: 'model', text: '', trace: [], pending: true },
    ]);
    s.busy.set(true);

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: agentId, message: text, history }),
      });
      if (!res.ok) {
        // Platform errors (e.g. Vercel timeouts) return non-JSON bodies — read
        // as text and only parse opportunistically.
        const body = await res.text();
        let msg = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(body);
          if (parsed?.error) msg = parsed.error;
        } catch { /* keep the status message */ }
        throw new Error(msg);
      }
      if (!res.body) throw new Error('Streaming not supported by this browser.');

      let sawDone = false;
      for await (const event of this.readEvents(res.body)) {
        switch (event.type) {
          case 'delta':
            this.updatePending(s, (p) => ({ ...p, text: p.text + event.text }));
            break;
          case 'draft-discard':
            this.updatePending(s, (p) => ({ ...p, text: '' }));
            break;
          case 'tool-start':
            this.updatePending(s, (p) => ({
              ...p,
              trace: [...(p.trace ?? []), { tool: event.tool, args: event.args, summary: '', running: true }],
            }));
            break;
          case 'tool-end':
            this.updatePending(s, (p) => {
              const trace = [...(p.trace ?? [])];
              for (let i = trace.length - 1; i >= 0; i--) {
                if (trace[i].running && trace[i].tool === event.tool) {
                  trace[i] = { ...trace[i], summary: event.summary, running: false };
                  break;
                }
              }
              return { ...p, trace };
            });
            break;
          case 'done':
            s.model.set(event.model);
            sawDone = true;
            break;
          case 'error':
            throw new Error(event.error);
        }
      }
      if (!sawDone) throw new Error('The connection dropped mid-answer.');

      // Finalize: pending → completed (or a friendly error if nothing arrived).
      this.updatePending(s, (p) =>
        p.text.trim()
          ? { ...p, pending: false }
          : { ...p, pending: false, error: true, text: 'The agent did not produce an answer — try rephrasing.' }
      );
    } catch (err) {
      this.markLastUserErrored(s);
      this.updatePending(s, (p) => ({
        ...p,
        pending: false,
        error: true,
        text: `Something went wrong: ${err instanceof Error ? err.message : err}`,
      }));
    } finally {
      s.busy.set(false);
    }
  }

  /** Parse an NDJSON byte stream into events. */
  private async *readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) yield JSON.parse(line) as StreamEvent;
        }
      }
      const rest = buffer.trim();
      if (rest) yield JSON.parse(rest) as StreamEvent;
    } finally {
      reader.releaseLock();
    }
  }

  /** History = complete successful user→model pairs only. Failed or empty
   *  turns are dropped so we never replay dangling questions or empty model
   *  parts (which Gemini rejects). */
  private buildHistory(s: AgentChatState): { role: 'user' | 'model'; text: string }[] {
    const msgs = s.messages();
    const pairs: { role: 'user' | 'model'; text: string }[] = [];
    for (let i = 0; i + 1 < msgs.length; i++) {
      const user = msgs[i];
      const model = msgs[i + 1];
      const userOk = user.role === 'user' && !user.pending && !user.error && user.text.trim();
      const modelOk = model.role === 'model' && !model.pending && !model.error && model.text.trim();
      if (userOk && modelOk) {
        pairs.push({ role: 'user', text: user.text }, { role: 'model', text: model.text });
        i++; // consume the pair
      }
    }
    return pairs;
  }

  private updatePending(s: AgentChatState, fn: (p: ChatMessage) => ChatMessage): void {
    s.messages.update((m) => m.map((x) => (x.pending ? fn(x) : x)));
  }

  /** On failure, flag the question too, so the broken pair is excluded from
   *  future history rather than replayed as a dangling user turn. */
  private markLastUserErrored(s: AgentChatState): void {
    s.messages.update((m) => {
      const copy = [...m];
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === 'user') {
          copy[i] = { ...copy[i], error: true };
          break;
        }
      }
      return copy;
    });
  }
}
