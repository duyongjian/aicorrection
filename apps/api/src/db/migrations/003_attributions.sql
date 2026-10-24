CREATE TABLE IF NOT EXISTS attributions (
  attribution_id     TEXT PRIMARY KEY,
  loop_id            TEXT NOT NULL REFERENCES loop_sessions(loop_id),
  anon_user_id       TEXT NOT NULL,
  mistake_id         TEXT REFERENCES mistakes(mistake_id),
  cause              TEXT,
  knowledge_point    TEXT,
  essence            TEXT,
  attr_model_version TEXT,
  attr_latency_ms    INTEGER,
  rate_action        TEXT CHECK (rate_action IN ('approve','inaccurate','report')),
  inaccurate_reason  TEXT CHECK (inaccurate_reason IN ('not_essence','wrong_knowledge','wrong_cause','other')),
  expert_consistency TEXT CHECK (expert_consistency IN ('agree','disagree')),
  expert_accuracy    TEXT CHECK (expert_accuracy IN ('accurate','inaccurate')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attr_loop ON attributions(loop_id);
CREATE INDEX IF NOT EXISTS idx_attr_user ON attributions(anon_user_id);
