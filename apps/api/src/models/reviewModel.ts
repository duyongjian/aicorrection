/**
 * 复习调度数据访问层（P2：R15 间隔复习 / R16 复习列表 / R12 变式题）。
 * review_schedule = 何时提醒（计划）；review_sessions = 一次复测事件（流水）。
 */
import { getDb } from '../db';
import type { ReviewScheduleItem } from '@aicorrection/shared';

export function upsertReviewSchedule(row: {
  anon_user_id: string;
  kp_key: string;
  kp_text: string | null;
  interval_days: number;
  ease: number;
  last_result: 'correct' | 'wrong' | 'skip' | null;
  next_review_ts: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO review_schedule (
         anon_user_id, kp_key, kp_text, interval_days, ease, last_result, next_review_ts, updated_at
       ) VALUES (@anon_user_id, @kp_key, @kp_text, @interval_days, @ease, @last_result, @next_review_ts, datetime('now'))
       ON CONFLICT(anon_user_id, kp_key) DO UPDATE SET
         kp_text = excluded.kp_text,
         interval_days = excluded.interval_days,
         ease = excluded.ease,
         last_result = excluded.last_result,
         next_review_ts = excluded.next_review_ts,
         updated_at = datetime('now')`
    )
    .run(row);
}

export function getReviewSchedule(
  anon_user_id: string,
  kp_key: string
): ReviewScheduleItem | undefined {
  return getDb()
    .prepare('SELECT * FROM review_schedule WHERE anon_user_id = ? AND kp_key = ?')
    .get(anon_user_id, kp_key) as ReviewScheduleItem | undefined;
}

/** R16：该用户所有已到期（next_review_ts <= nowIso，或尚未排程）的复习计划。 */
export function getDueReviews(
  anon_user_id: string,
  nowIso: string
): ReviewScheduleItem[] {
  return getDb()
    .prepare(
      `SELECT * FROM review_schedule
       WHERE anon_user_id = ? AND (next_review_ts IS NULL OR next_review_ts <= ?)
       ORDER BY next_review_ts ASC, kp_key ASC`
    )
    .all(anon_user_id, nowIso) as ReviewScheduleItem[];
}

export function getAllReviewSchedule(anon_user_id: string): ReviewScheduleItem[] {
  return getDb()
    .prepare('SELECT * FROM review_schedule WHERE anon_user_id = ? ORDER BY updated_at DESC')
    .all(anon_user_id) as ReviewScheduleItem[];
}

export function insertReviewSession(row: {
  review_id: string;
  anon_user_id: string;
  source_loop_id: string | null;
  target_kp: string;
  push_ts: string;
  is_variant: 0 | 1;
}): void {
  getDb()
    .prepare(
      `INSERT INTO review_sessions (review_id, anon_user_id, source_loop_id, target_kp, push_ts, is_variant)
       VALUES (@review_id, @anon_user_id, @source_loop_id, @target_kp, @push_ts, @is_variant)`
    )
    .run(row);
}

export function updateReviewSessionReturn(
  review_id: string,
  return_ts: string,
  days_since_verify: number | null,
  retest_result: 'correct' | 'wrong' | 'skip'
): void {
  getDb()
    .prepare(
      `UPDATE review_sessions SET return_ts = ?, days_since_verify = ?, retest_result = ? WHERE review_id = ?`
    )
    .run(return_ts, days_since_verify, retest_result, review_id);
}

export function getReviewSession(review_id: string) {
  return getDb()
    .prepare('SELECT * FROM review_sessions WHERE review_id = ?')
    .get(review_id) as
    | {
        review_id: string;
        anon_user_id: string;
        source_loop_id: string | null;
        target_kp: string;
        push_ts: string;
        return_ts: string | null;
        retest_result: 'correct' | 'wrong' | 'skip' | null;
        days_since_verify: number | null;
        is_variant: 0 | 1;
      }
    | undefined;
}
