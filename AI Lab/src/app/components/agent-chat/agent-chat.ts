import { Component, ElementRef, ViewChild, effect, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgentService } from '../../services/agent.service';

/** One lab stage's chat: a thin, reusable shell over AgentService. Each
 *  agentId keeps its own conversation in the service, so switching tabs
 *  doesn't lose anything. */
@Component({
  selector: 'app-agent-chat',
  imports: [FormsModule],
  templateUrl: './agent-chat.html',
  styleUrl: './agent-chat.scss',
})
export class AgentChat {
  readonly agentId = input.required<string>();
  readonly heading = input('');
  readonly description = input('');
  readonly starters = input<string[]>([]);

  readonly agent = inject(AgentService);
  draft = '';

  @ViewChild('thread') thread?: ElementRef<HTMLElement>;

  get state() {
    return this.agent.state(this.agentId());
  }

  constructor() {
    this.agent.checkHealth();
    // Follow new messages, but never yank the user back down if they've
    // scrolled up to re-read something.
    effect(() => {
      this.agent.state(this.agentId()).messages();
      const el = this.thread?.nativeElement;
      const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      if (!nearBottom) return;
      queueMicrotask(() =>
        this.thread?.nativeElement.scrollTo({ top: this.thread.nativeElement.scrollHeight, behavior: 'smooth' })
      );
    });
  }

  send(text?: string): void {
    const fromDraft = text === undefined;
    const message = (text ?? this.draft).trim();
    if (!message) return;
    if (fromDraft) this.draft = '';   // a starter click must not wipe a typed draft
    this.agent.send(this.agentId(), message);
  }

  argsPreview(args: Record<string, unknown>): string {
    const entries = Object.entries(args ?? {});
    if (!entries.length) return '';
    return entries.map(([k, v]) => `${k}: ${v}`).join(', ');
  }
}
