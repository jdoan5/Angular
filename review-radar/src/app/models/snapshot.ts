// Contract for public/gold_snapshot.json — written by the gold-snapshot
// GitHub Action (see .github/workflows/ at the repo root), which executes
// .github/workflows/gold_snapshot.sql against the Databricks SQL warehouse
// and commits the result. Keep this file and that SQL in sync.

export interface Totals {
  reviews_collected: number;
  overall_avg_rating: number;
  apps_tracked: number;
}

export interface OverviewRow {
  app_name: string;
  reviews_collected: number;
  avg_rating: number;
  versions_seen: number;
  oldest_review_at: string;
  newest_review_at: string;
}

export interface VersionRow {
  app_name: string;
  app_version: string;
  n_reviews: number;
  avg_rating: number;
  first_review_at: string;
}

export interface WeekRow {
  app_name: string;
  week: string;
  n_reviews: number;
  avg_rating: number;
  is_partial_week: boolean;
}

export interface Snapshot {
  generated_at?: string;
  totals: Totals;
  overview: OverviewRow[];
  rating_by_version: VersionRow[];
  weekly_velocity: WeekRow[];
}
