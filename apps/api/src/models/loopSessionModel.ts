/**
 * loop_sessions 数据访问层（UPL-02 / FLW-01）
 * loop_complete / verify_* 字段仅预埋，v0.1 不写真值。
 */
import { getDb } from '../db';
import type { LoopSession } from '@aicorrection/shared';

export function createLoopSession(loopSession: LoopSession): void {
  getDb()
    .prepare(
      `INSERT INTO loop_sessions (
        loop_id, anon_user_id, segment, session_id, start_ts,
        complete_ts, duration_ms, loop_complete, verify_result, verify_rounds,
        followup_rounds, has_practice, restate_len, restate_is_copy
      ) VALUES (
        @loop_id, @anon_user_id, @segment, @session_id, @start_ts,
        @complete_ts, @duration_ms, @loop_complete, @verify_result, @verify_rounds,
        @followup_rounds, @has_practice, @restate_len, @restate_is_copy
      )`
    )
    .run(loopSession);
}

export function getLoopSession(loop_id: string): LoopSession | undefined {
  return getDb()
    .prepare('SELECT * FROM loop_sessions WHERE loop_id = ?')
    .get(loop_id) as LoopSession | undefined;
}

export function incrementFollowupRounds(loop_id: string): void {
  getDb()
    .prepare(
      'UPDATE loop_sessions SET followup_rounds = followup_rounds + 1 WHERE loop_id = ?'
    )
    .run(loop_id);
}

/** R07 闭环完成：标记完成时间 + 中位时长（now - start_ts）。 */
export function completeLoopSession(loop_id: string): void {
  const session = getLoopSession(loop_id);
  if (!session) return;
  const startMs = new Date(session.start_ts.replace(' ', 'T') + 'Z').getTime();
  const now = Date.now();
  const durationMs = Number.isFinite(startMs) ? now - startMs : 0;
  getDb()
    .prepare(
      `UPDATE loop_sessions SET loop_complete = 1, complete_ts = ?, duration_ms = ? WHERE loop_id = ?`
    )
    .run(new Date(now).toISOString(), durationMs, loop_id);
}

/**
 * 统计某用户「今天」已创建的闭环数（按 UTC 日期，与 created_at 写入口径一致）。
 * 用于 unlimited_loops 权益的每日配额：免费版每日限 FREE_DAILY_LOOP_QUOTA 次。
 */
export function countLoopsToday(anonUserId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS cnt FROM loop_sessions
       WHERE anon_user_id = ? AND DATE(created_at) = DATE('now')`
    )
    .get(anonUserId) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}
