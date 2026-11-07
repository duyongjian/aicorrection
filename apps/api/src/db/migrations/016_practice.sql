/**
 * v0.2 五步闭环补全：R04 同类题（practice_items）、R05 复述（loop_sessions 扩展）、
 * R06 追问验证（loop_sessions 扩展）。
 *
 * 设计：practice_items 独立成表，支持 R13 后续多题组（group_id/group_seq）的平滑升级；
 * 复述与验证的轻量字段直接落在 loop_sessions（一次闭环一份结论），避免无谓 JOIN。
 *
 * 数据主权：用户作答 user_answer 仅存服务端，不回传给任何外部模型作为检索内容。
 */

-- 同类题 / 针对性练习题组
CREATE TABLE IF NOT EXISTS practice_items (
  practice_id   TEXT PRIMARY KEY,
  loop_id       TEXT NOT NULL,
  anon_user_id  TEXT NOT NULL,
  kp_id         TEXT,
  question_text TEXT NOT NULL,
  answer_text   TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'qbank' CHECK (source IN ('qbank', 'llm')),
  user_answer   TEXT,
  is_correct    INTEGER CHECK (is_correct IN (0, 1)),
  graded_by     TEXT CHECK (graded_by IN ('llm', 'heuristic', 'manual')),
  group_id      TEXT,
  group_seq     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_practice_loop ON practice_items(loop_id);
CREATE INDEX IF NOT EXISTS idx_practice_user ON practice_items(anon_user_id);
CREATE INDEX IF NOT EXISTS idx_practice_kp   ON practice_items(kp_id);

-- R05 复述本质：完整文本 + 是否复制粘贴判定
ALTER TABLE loop_sessions ADD COLUMN restate_text TEXT;

-- R06 追问验证：探针问题、用户应答、AI 判定反馈
ALTER TABLE loop_sessions ADD COLUMN verify_prompt    TEXT;
ALTER TABLE loop_sessions ADD COLUMN verify_response  TEXT;
ALTER TABLE loop_sessions ADD COLUMN verify_feedback  TEXT;
