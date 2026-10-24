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
