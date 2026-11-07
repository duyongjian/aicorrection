/**
 * P2 间隔复习（R15 间隔复习 / R16 复习列表 / R12 变式题）。
 *
 * review_schedule：每个「用户-知识点」一条复习计划（SM-2 简化版）。
 *   - interval_days：当前复习间隔（天），正确则翻倍（封顶 30），错误则归 1；
 *   - next_review_ts：下一次应复习时间；在 master_state 升级到 familiar/mastered 时首次排程，
 *     或在 R15 复测回流时按结果刷新。
 *   - 与既有 review_sessions（复测事件流水）解耦：schedule 是"何时提醒"，session 是"一次复测发生了什么"。
 *
 * 数据主权：仅存知识点键与计划时间，不回传任何作答内容到外部模型。
 */

CREATE TABLE IF NOT EXISTS review_schedule (
  anon_user_id   TEXT NOT NULL,
  kp_key         TEXT NOT NULL,
  kp_text        TEXT,
  interval_days  INTEGER NOT NULL DEFAULT 1,
  ease           REAL NOT NULL DEFAULT 2.5,
  last_result    TEXT CHECK (last_result IS NULL OR last_result IN ('correct', 'wrong', 'skip')),
  next_review_ts TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (anon_user_id, kp_key)
);
CREATE INDEX IF NOT EXISTS idx_review_schedule_due ON review_schedule(anon_user_id, next_review_ts);
