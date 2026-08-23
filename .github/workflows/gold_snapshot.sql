-- Review Radar: packs the gold layer into one JSON document (single cell).
-- Executed by gold-snapshot.yml via the Databricks SQL Statement Execution API.
-- Keep the shape in sync with review-radar/src/app/models/snapshot.ts.
-- ignoreNullFields=false: a NULL must surface as an explicit null in the JSON,
-- never as a silently missing key the app would trip over.
SELECT to_json(named_struct(
  'totals', (
    SELECT struct(
      COUNT(*)                AS reviews_collected,
      ROUND(AVG(rating), 2)   AS overall_avg_rating,
      COUNT(DISTINCT app_id)  AS apps_tracked
    )
    FROM workspace.review_radar.silver_reviews
  ),
  'overview', (
    SELECT collect_list(struct(
      app_name, reviews_collected, avg_rating, versions_seen,
      oldest_review_at, newest_review_at
    ))
    FROM workspace.review_radar.gold_app_overview
  ),
  'rating_by_version', (
    SELECT collect_list(struct(
      app_name, app_version, n_reviews, avg_rating, first_review_at
    ))
    FROM workspace.review_radar.gold_rating_by_version
  ),
  'weekly_velocity', (
    SELECT collect_list(struct(
      app_name, week, n_reviews, avg_rating, is_partial_week
    ))
    FROM workspace.review_radar.gold_review_velocity
  )
), map('ignoreNullFields', 'false'))
