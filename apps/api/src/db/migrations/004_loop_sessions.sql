CREATE TABLE IF NOT EXISTS loop_sessions (
  loop_id         TEXT PRIMARY KEY,
  anon_user_id    TEXT NOT NULL REFERENCES users(anon_user_id),
  segment         TEXT,
  session_id      TEXT,
  start_ts        TEXT NOT NULL,
  complete_ts     TEXT,
  duration_ms     INTEGER,
  loop_complete   INTEGER NOT NULL DEFAULT 0 CHECK (loop_complete IN (0,1)),
  verify_result   TEXT CHECK (verify_result IN ('pass','fail','give_up')),
  verify_rounds   INTEGER,
  followup_rounds INTEGER NOT NULL DEFAULT 0,
  has_practice    INTEGER CHECK (has_practice IN (0,1)),
  restate_len     INTEGER,
  restate_is_copy INTEGER CHECK (restate_is_copy IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loop_user  ON loop_sessions(anon_user_id);
CREATE INDEX IF NOT EXISTS idx_loop_start ON loop_sessions(start_ts);
