import { Component, input } from '@angular/core';
import { OverviewRow } from '../models/snapshot';
import { appColor } from './palette';

// Horizontal rating bars — one per app, width proportional to avg rating (of 5).
@Component({
  selector: 'app-rating-bars',
  template: `
    @for (row of rows(); track row.app_name) {
      <div class="bar-row">
        <span class="bar-label" [title]="row.app_name">{{ row.app_name }}</span>
        <div class="bar-track">
          <div
            class="bar-fill"
            [style.width.%]="(row.avg_rating / 5) * 100"
            [style.background]="color(row.app_name)"
          ></div>
        </div>
        <span class="bar-value">{{ row.avg_rating.toFixed(2) }}</span>
      </div>
    }
  `,
  styles: `
    .bar-row {
      display: grid;
      grid-template-columns: minmax(0, 180px) 1fr 48px;
      gap: 10px;
      align-items: center;
      margin: 8px 0;
    }
    .bar-label {
      font-size: 0.85rem;
      color: var(--ink-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bar-track {
      background: var(--panel-edge);
      border-radius: 6px;
      height: 14px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: 6px;
    }
    .bar-value {
      font-size: 0.85rem;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
  `,
})
export class RatingBars {
  rows = input.required<OverviewRow[]>();
  color = appColor;
}
