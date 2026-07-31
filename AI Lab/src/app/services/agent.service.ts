import { Injectable, signal } from '@angular/core';

export interface ToolTraceStep {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  trace?: ToolTraceStep[];
  pending?: boolean;
  error?: boolean;
}

interface AgentResponse {
  text: string;
  trace: ToolTraceStep[];
  model: string;
}

/** Talks to the server-side agent (POST /api/agent). The Gemini key never
 *  reaches the browser — this service only ever sees answers and traces. */
@Injectable({ providedIn: 'root' })
export class AgentService {
  readonly messages = signal<ChatMessage[]>([]);
  readonly busy = signal(false);
  readonly configured = signal<boolean | null>(null);
  readonly model = signal<string>('');

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

  /** History = complete successful user→model pairs only. Failed or empty
   *  turns are dropped so we never replay dangling questions or empty model
   *  parts (which Gemini rejects). */
  private buildHistory(): { role: 'user' | 'model'; text: string }[] {
    const msgs = this.messages();
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

  async send(message: string): Promise<void> {
    const text = message.trim();
    if (!text || this.busy()) return;

    const history = this.buildHistory();

    this.messages.update((m) => [
      ...m,
      { role: 'user', text },
      { role: 'model', text: '', pending: true },
    ]);
    this.busy.set(true);

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
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
      const data: AgentResponse = await res.json();
      this.model.set(data.model);
      if (data.text?.trim()) {
        this.replacePending({ role: 'model', text: data.text, trace: data.trace });
      } else {
        // Shouldn't happen (server guards it) — but never show a blank bubble
        // or let an empty turn poison future history.
        this.replacePending({
          role: 'model',
          text: 'The agent did not produce an answer — try rephrasing.',
          trace: data.trace,
          error: true,
        });
      }
    } catch (err) {
      this.markLastUserErrored();
      this.replacePending({
        role: 'model',
        text: `Something went wrong: ${err instanceof Error ? err.message : err}`,
        error: true,
      });
    } finally {
      this.busy.set(false);
    }
  }

  private replacePending(message: ChatMessage): void {
    this.messages.update((m) => {
      const copy = [...m];
      const i = copy.findIndex((x) => x.pending);
      if (i >= 0) copy[i] = message;
      else copy.push(message);
      return copy;
    });
  }

  /** On failure, flag the question too, so the broken pair is excluded from
   *  future history rather than replayed as a dangling user turn. */
  private markLastUserErrored(): void {
    this.messages.update((m) => {
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
