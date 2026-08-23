import { Component, computed, input } from '@angular/core';
import { WeekRow } from '../models/snapshot';

interface WeekBar {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
}

// Total reviews per week across all tracked apps, complete weeks only —
// partial first/current weeks are excluded upstream and here, so the series
// never fakes a cliff or a ramp.
@Component({
  selector: 'app-weekly-bars',
  template: `
    <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" preserveAspectRatio="xMidYMid meet">
      @for (b of bars(); track b.x) {
        <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h" rx="1.5" class="bar">
          <title>{{ b.title }}</title>
        </rect>
      }
      @for (t of ticks(); track t.week) {
        <text [attr.x]="t.x" [attr.y]="H - 6" class="tick" text-anchor="middle">{{ t.label }}</text>
      }
    </svg>
  `,
  styles: `
    svg {
      width: 100%;
      height: auto;
      display: block;
    }
    .bar {
      fill: var(--accent);
      fill-opacity: 0.85;
    }
    .tick {
      fill: var(--ink-dim);
      font-size: 11px;
    }
  `,
})
export class WeeklyBars {
  rows = input.required<WeekRow[]>();

  readonly W = 900;
  readonly H = 180;

  private weeks = computed(() => {
    const totals = new Map<string, number>();
    for (const r of this.rows()) {
      if (r.is_partial_week) continue;
      totals.set(r.week, (totals.get(r.week) ?? 0) + r.n_reviews);
    }
    return [...totals.entries()]
      .map(([week, n]) => ({ week, n }))
      .sort((a, b) => a.week.localeCompare(b.week));
  });

  bars = computed<WeekBar[]>(() => {
    const weeks = this.weeks();
    if (weeks.length === 0) return [];
    const maxN = Math.max(...weeks.map((w) => w.n));
    const slot = this.W / weeks.length;
    const bw = Math.max(1.5, Math.min(14, slot * 0.7));
    return weeks.map((w, i) => {
      const h = maxN ? (w.n / maxN) * (this.H - 34) : 0;
      return {
        x: i * slot + (slot - bw) / 2,
        y: this.H - 22 - h,
        w: bw,
        h,
        title: `week of ${w.week.slice(0, 10)} — ${w.n} reviews`,
      };
    });
  });

  ticks = computed(() => {
    const weeks = this.weeks();
    if (weeks.length === 0) return [];
    const step = Math.max(1, Math.floor(weeks.length / 6));
    const slot = this.W / weeks.length;
    return weeks
      .filter((_, i) => i % step === 0)
      .map((w) => ({
        week: w.week,
        label: w.week.slice(0, 7),
        x: weeks.findIndex((x) => x.week === w.week) * slot + slot / 2,
      }));
  });
}
