/**
 * 题库表（P1 题库 RAG）：与 §4.1 字段规范一致，
 * 追加两列：embedding_vec（JSON 数组，纯 SQLite 余弦用）与 embedding_model（记录嵌入方案）。
 * 保留 embedding_status（pending|done|failed）与 embedding_model 原字段。
 */
CREATE TABLE IF NOT EXISTS qbank_items (
  item_id           TEXT PRIMARY KEY,
  subject           TEXT NOT NULL,
  question_text     TEXT NOT NULL,
  answer_text       TEXT NOT NULL,
  knowledge_point   TEXT NOT NULL,
  solution_steps    TEXT,
  grade_level       TEXT,
  difficulty        INTEGER,
  source            TEXT,
  license           TEXT,
  cause_tags_json   TEXT,
  embedding_status  TEXT NOT NULL DEFAULT 'pending',  -- pending|done|failed
  embedding_model   TEXT,                              -- 使用的嵌入方案（local-hash | bge ...）
  embedding_vec     TEXT,                              -- 纯 SQLite 余弦检索用：JSON 数组（D 维）
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_qbank_subject ON qbank_items(subject);
CREATE INDEX IF NOT EXISTS idx_qbank_kp      ON qbank_items(knowledge_point);
