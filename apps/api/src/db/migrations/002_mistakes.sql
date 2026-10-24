CREATE TABLE IF NOT EXISTS mistakes (
  mistake_id   TEXT PRIMARY KEY,
  anon_user_id TEXT NOT NULL REFERENCES users(anon_user_id),
  loop_id      TEXT NOT NULL,
  subject      TEXT,
  src_type     TEXT NOT NULL CHECK (src_type IN ('photo','text','paste')),
  ocr_status   TEXT NOT NULL CHECK (ocr_status IN ('success','partial','fail')),
  mistake_ref  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mistakes_user ON mistakes(anon_user_id);
CREATE INDEX IF NOT EXISTS idx_mistakes_loop ON mistakes(loop_id);
