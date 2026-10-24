CREATE TABLE IF NOT EXISTS review_sessions (
  review_id        TEXT PRIMARY KEY,
  anon_user_id     TEXT,
  source_loop_id   TEXT,
  target_kp        TEXT,
  push_ts          TEXT,
  return_ts        TEXT,
  retest_result    TEXT CHECK (retest_result IN ('correct','wrong','skip')),
  days_since_verify INTEGER,
  is_variant       INTEGER CHECK (is_variant IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
