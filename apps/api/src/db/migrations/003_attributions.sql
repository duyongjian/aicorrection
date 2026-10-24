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
  -- J8: 结构化字段（nullable）
  knowledge_point_id TEXT CHECK (knowledge_point_id IS NULL OR knowledge_point_id LIKE 'kp_%'),
  cause_id TEXT CHECK (cause_id IS NULL OR cause_id IN ('concept_confusion','method_error','calculation_error','reading_error','memory_gap','other')),
  kq_taxonomy_version TEXT NOT NULL DEFAULT 'v0.1',
  cause_taxonomy_version TEXT NOT NULL DEFAULT 'v0.1',
  -- T4: 服务端打标
  is_mock INTEGER NOT NULL DEFAULT 0 CHECK (is_mock IN (0, 1)),
  is_internal INTEGER NOT NULL DEFAULT 0 CHECK (is_internal IN (0, 1)),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attr_loop ON attributions(loop_id);
CREATE INDEX IF NOT EXISTS idx_attr_user ON attributions(anon_user_id);
CREATE INDEX IF NOT EXISTS idx_attr_kp ON attributions(knowledge_point_id);
CREATE INDEX IF NOT EXISTS idx_attr_cause ON attributions(cause_id);
