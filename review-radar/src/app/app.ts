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
  /** Whole days since the lakehouse generated this snapshot; null if the file
   *  predates the generated_at field or carries an unparseable value.
   *
   *  Read once at load — the page is a static snapshot viewer, so there is
   *  nothing to re-evaluate against a ticking clock. */
  readonly snapshotAgeDays = computed(() => {
    const at = this.snapshot()?.generated_at;
    if (!at) return null;
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) return null;
    return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
  });

  /** The daily Action refreshes this file, so anything older than a couple of
   *  days means a run has been failing. That went unnoticed for eleven days
   *  once, because a red mark in the Actions tab is easy not to look at — the
   *  warning belongs here, where the stale data is actually being read. */
  readonly staleness = computed<'fresh' | 'warn' | 'critical' | 'unknown'>(() => {
    const days = this.snapshotAgeDays();
    if (days === null) return 'unknown';
    if (days >= 7) return 'critical';
    if (days >= 2) return 'warn';
    return 'fresh';
  });

  readonly versionRows = computed(() => this.snapshot()?.rating_by_version ?? []);
  readonly weeklyRows = computed(() => this.snapshot()?.weekly_velocity ?? []);
  // Complete weeks only — if every row is partial (a sparse first snapshot),
  // the section shows its empty state instead of a blank chart.
  readonly completeWeeks = computed(() =>
    this.weeklyRows().filter((r) => !r.is_partial_week),
  );
}
