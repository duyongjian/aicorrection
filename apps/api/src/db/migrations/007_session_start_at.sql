-- Migration 007: 预埋 session_start_at 字段（loop_sessions）
-- §13 K1.2b：screen_view 事件需在 loop_sessions 中记录会话起始时间
ALTER TABLE loop_sessions ADD COLUMN session_start_at TEXT;
CREATE INDEX IF NOT EXISTS idx_loop_session_start ON loop_sessions(session_start_at);
