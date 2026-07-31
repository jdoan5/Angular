import { Component, ElementRef, ViewChild, effect, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgentService } from '../../services/agent.service';

@Component({
  selector: 'app-review-analyst',
  imports: [FormsModule],
  templateUrl: './review-analyst.html',
  styleUrl: './review-analyst.scss',
})
export class ReviewAnalyst implements OnInit {
  readonly agent = inject(AgentService);
  draft = '';

  @ViewChild('thread') thread?: ElementRef<HTMLElement>;

  readonly starters = [
    'How are my apps rated overall?',
    'Summarize the latest reviews of Cosmic Cadets',
    'What do reviewers complain about most, across all my apps?',
    'Draft a friendly reply to the most critical recent review',
  ];

  constructor() {
    // Follow new messages, but never yank the user back down if they've
    // scrolled up to re-read something.
    effect(() => {
      this.agent.messages();
      const el = this.thread?.nativeElement;
      const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      if (!nearBottom) return;
      queueMicrotask(() =>
        this.thread?.nativeElement.scrollTo({ top: this.thread.nativeElement.scrollHeight, behavior: 'smooth' })
      );
    });
  }

  ngOnInit(): void {
    this.agent.checkHealth();
  }

  send(text?: string): void {
    const fromDraft = text === undefined;
    const message = (text ?? this.draft).trim();
    if (!message) return;
    if (fromDraft) this.draft = '';   // a starter click must not wipe a typed draft
    this.agent.send(message);
  }

  argsPreview(args: Record<string, unknown>): string {
    const entries = Object.entries(args ?? {});
    if (!entries.length) return '';
    return entries.map(([k, v]) => `${k}: ${v}`).join(', ');
  }
}
