CREATE TABLE IF NOT EXISTS analytics_events (
  event_id        TEXT PRIMARY KEY,
  event_name      TEXT NOT NULL,
  anon_user_id    TEXT,
  loop_id         TEXT,
  session_id      TEXT,
  context_json    TEXT NOT NULL,
  props_json      TEXT NOT NULL,
  ts_utc          TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  received_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_name ON analytics_events(event_name);
CREATE INDEX IF NOT EXISTS idx_events_loop ON analytics_events(loop_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON analytics_events(anon_user_id);
