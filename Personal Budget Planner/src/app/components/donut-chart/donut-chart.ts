import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';

export interface DonutDatum {
  label: string;
  value: number;
  color: string;
}

interface Segment extends DonutDatum {
  dash: number;
  offset: number;
  percent: number;
}

/**
 * Dependency-free donut chart. The circle radius is chosen so its
 * circumference is exactly 100, letting each segment's percentage map
 * directly onto `stroke-dasharray`.
 */
@Component({
  selector: 'app-donut-chart',
  imports: [CurrencyPipe, DecimalPipe],
  templateUrl: './donut-chart.html',
  styleUrl: './donut-chart.scss',
})
export class DonutChart {
  readonly data = input<DonutDatum[]>([]);
  readonly centerLabel = input('Total');

  protected readonly total = computed(() =>
    this.data().reduce((sum, d) => sum + d.value, 0),
  );

  protected readonly segments = computed<Segment[]>(() => {
    const total = this.total();
    if (total <= 0) return [];
    let cumulative = 0;
    return this.data()
      .filter((d) => d.value > 0)
      .map((d) => {
        const percent = (d.value / total) * 100;
        const segment: Segment = {
          ...d,
          percent,
          dash: percent,
          offset: 25 - cumulative,
        };
        cumulative += percent;
        return segment;
      });
  });
}
