-- 021_followups：持久化追问对话，使「进入历史可回顾追问」成立。
-- 此前 followup 仅自增 loop_sessions.followup_rounds，追问文本不落库，无法回看。
CREATE TABLE IF NOT EXISTS followups (
  followup_id TEXT PRIMARY KEY,
  loop_id     TEXT NOT NULL,
  anon_user_id TEXT NOT NULL,
  seq         INTEGER NOT NULL,        -- 同一 loop 内按对话顺序
  role        TEXT NOT NULL CHECK (role IN ('user', 'ai')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_followups_loop ON followups(loop_id);
CREATE INDEX IF NOT EXISTS idx_followups_user ON followups(anon_user_id);
