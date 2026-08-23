import { Component, computed, inject } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { SnapshotService } from './services/snapshot.service';
import { RatingBars } from './components/rating-bars';
import { VersionScatter } from './components/version-scatter';
import { WeeklyBars } from './components/weekly-bars';

@Component({
  selector: 'app-root',
  imports: [DatePipe, DecimalPipe, RatingBars, VersionScatter, WeeklyBars],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly svc = inject(SnapshotService);

  readonly snapshot = this.svc.snapshot;
  readonly error = this.svc.error;

  readonly overview = computed(() =>
    [...(this.snapshot()?.overview ?? [])].sort(
      (a, b) => b.reviews_collected - a.reviews_collected,
    ),
  );
  readonly versionRows = computed(() => this.snapshot()?.rating_by_version ?? []);
  readonly weeklyRows = computed(() => this.snapshot()?.weekly_velocity ?? []);
  // Complete weeks only — if every row is partial (a sparse first snapshot),
  // the section shows its empty state instead of a blank chart.
  readonly completeWeeks = computed(() =>
    this.weeklyRows().filter((r) => !r.is_partial_week),
  );
}
