import { Component, computed, input } from '@angular/core';
import { VersionRow } from '../models/snapshot';
import { appColor } from './palette';

interface Dot {
  cx: number;
  cy: number;
  r: number;
  fill: string;
  title: string;
}

// One dot per app version: x = first review date, y = avg rating,
// size = number of reviews behind it. Hand-rolled SVG, no chart library.
@Component({
  selector: 'app-version-scatter',
  template: `
    <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" preserveAspectRatio="xMidYMid meet">
      <!-- rating gridlines -->
      @for (g of gridlines; track g.rating) {
        <line [attr.x1]="PAD" [attr.x2]="W - 8" [attr.y1]="g.y" [attr.y2]="g.y" class="grid" />
        <text [attr.x]="PAD - 6" [attr.y]="g.y + 4" class="tick" text-anchor="end">{{ g.rating }}</text>
      }
      <!-- year ticks -->
      @for (t of yearTicks(); track t.label) {
        <text [attr.x]="t.x" [attr.y]="H - 6" class="tick" text-anchor="middle">{{ t.label }}</text>
      }
      @for (d of dots(); track d.title) {
        <circle [attr.cx]="d.cx" [attr.cy]="d.cy" [attr.r]="d.r" [attr.fill]="d.fill" fill-opacity="0.75">
          <title>{{ d.title }}</title>
        </circle>
      }
    </svg>
    <div class="legend">
      @for (name of apps(); track name) {
        <span class="chip"><i [style.background]="color(name)"></i>{{ name }}</span>
      }
    </div>
  `,
  styles: `
    svg {
      width: 100%;
      height: auto;
      display: block;
    }
    .grid {
      stroke: var(--panel-edge);
      stroke-width: 1;
    }
    .tick {
      fill: var(--ink-dim);
      font-size: 11px;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
      margin-top: 10px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.78rem;
      color: var(--ink-dim);
    }
    .chip i {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
    }
  `,
})
export class VersionScatter {
  rows = input.required<VersionRow[]>();

  readonly W = 900;
  readonly H = 340;
  readonly PAD = 34;

  readonly gridlines = [1, 2, 3, 4, 5].map((rating) => ({
    rating,
    y: this.yFor(rating),
  }));

  private yFor(rating: number): number {
    // rating 1..5 mapped top-down with vertical padding
    const top = 16;
    const bottom = this.H - 28;
    return bottom - ((rating - 1) / 4) * (bottom - top);
  }

  private range = computed(() => {
    const times = this.rows().map((r) => Date.parse(r.first_review_at));
    const min = Math.min(...times);
    const max = Math.max(...times);
    return { min, max: max === min ? min + 1 : max };
  });

  dots = computed<Dot[]>(() =>
    this.rows().map((r) => {
      const { min, max } = this.range();
      const t = (Date.parse(r.first_review_at) - min) / (max - min);
      return {
        cx: this.PAD + t * (this.W - this.PAD - 20),
        cy: this.yFor(r.avg_rating),
        r: Math.min(16, Math.max(3.5, Math.sqrt(r.n_reviews))),
        fill: appColor(r.app_name),
        title: `${r.app_name} v${r.app_version} — ${r.avg_rating} ★ (${r.n_reviews} reviews)`,
      };
    }),
  );

  yearTicks = computed(() => {
    const { min, max } = this.range();
    const first = new Date(min).getUTCFullYear() + 1;
    const last = new Date(max).getUTCFullYear();
    const ticks = [];
    for (let y = first; y <= last; y++) {
      const t = (Date.UTC(y, 0, 1) - min) / (max - min);
      ticks.push({ label: String(y), x: this.PAD + t * (this.W - this.PAD - 20) });
    }
    return ticks;
  });

  apps = computed(() => [...new Set(this.rows().map((r) => r.app_name))]);
  color = appColor;
}
