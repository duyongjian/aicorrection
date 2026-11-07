/**
 * 聚合数据访问层（P1：R09 错因聚合 / R10 薄弱点 / R14 掌握判定）。
 * 所有查询均为只读、跨会话，复用既有 attributions / practice_items / mastery_state。
 * kp_key 与 shared 的 normalizeKpKey 同口径：优先 knowledge_point_id，否则 'txt:<文本>'。
 */
import { getDb } from '../db';
import type { MasteryLevel } from '@aicorrection/shared';

/** R09：按 cause_id 聚合该用户错因计数。 */
export function getCauseCounts(
  anon_user_id: string
): Array<{ cause_id: string; count: number }> {
  return getDb()
    .prepare(
      `SELECT cause_id, COUNT(*) AS count
       FROM attributions
       WHERE anon_user_id = ? AND cause_id IS NOT NULL
       GROUP BY cause_id`
    )
    .all(anon_user_id) as Array<{ cause_id: string; count: number }>;
}

/**
 * R10：按知识点聚合错误数 + 错因分布。
 * 返回 (kp_key, kp_text, cause_id, cnt) 明细，由服务层归并出 top_cause 与 error_count。
 */
export function getKpCauseDetail(
  anon_user_id: string
): Array<{ kp_key: string; kp_text: string; cause_id: string | null; cnt: number }> {
  return getDb()
    .prepare(
      `SELECT
         COALESCE(NULLIF(knowledge_point_id, ''), 'txt:' || COALESCE(knowledge_point, '')) AS kp_key,
         COALESCE(NULLIF(knowledge_point, ''), '（未标注知识点）') AS kp_text,
         cause_id,
         COUNT(*) AS cnt
       FROM attributions
       WHERE anon_user_id = ?
       GROUP BY kp_key, kp_text, cause_id`
    )
    .all(anon_user_id) as Array<{
    kp_key: string;
    kp_text: string;
    cause_id: string | null;
    cnt: number;
  }>;
}

/** R10/R14：按 kp_id（=knowledge_point_id）聚合练习作答次数与答对数。 */
export function getPracticeStatsByKp(
  anon_user_id: string
): Array<{ kp_id: string; attempts: number; correct: number }> {
  return getDb()
    .prepare(
      `SELECT kp_id, COUNT(*) AS attempts, COALESCE(SUM(is_correct), 0) AS correct
       FROM practice_items
       WHERE anon_user_id = ? AND kp_id IS NOT NULL AND kp_id <> ''
       GROUP BY kp_id`
    )
    .all(anon_user_id) as Array<{ kp_id: string; attempts: number; correct: number }>;
}

/** R14：取单个掌握状态。 */
export function getMastery(
  anon_user_id: string,
  kp_key: string
): {
  anon_user_id: string;
  kp_key: string;
  kp_text: string;
  level: MasteryLevel;
  attempts: number;
  correct: number;
  correct_streak: number;
  last_practiced_ts: string | null;
  updated_at: string;
} | undefined {
  return getDb()
    .prepare('SELECT * FROM mastery_state WHERE anon_user_id = ? AND kp_key = ?')
    .get(anon_user_id, kp_key) as
    | {
        anon_user_id: string;
        kp_key: string;
        kp_text: string;
        level: MasteryLevel;
        attempts: number;
        correct: number;
        correct_streak: number;
        last_practiced_ts: string | null;
        updated_at: string;
      }
    | undefined;
}

/** R14：取该用户全部掌握状态。 */
export function getAllMastery(anon_user_id: string) {
  return getDb()
    .prepare('SELECT * FROM mastery_state WHERE anon_user_id = ? ORDER BY updated_at DESC')
    .all(anon_user_id) as Array<{
    anon_user_id: string;
    kp_key: string;
    kp_text: string;
    level: MasteryLevel;
    attempts: number;
    correct: number;
    correct_streak: number;
    last_practiced_ts: string | null;
    updated_at: string;
  }>;
}

/** R14：写入/覆盖掌握状态（幂等 upsert）。 */
export function upsertMastery(row: {
  anon_user_id: string;
  kp_key: string;
  kp_text: string;
  level: MasteryLevel;
  attempts: number;
  correct: number;
  correct_streak: number;
  last_practiced_ts: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO mastery_state (
         anon_user_id, kp_key, kp_text, level, attempts, correct, correct_streak, last_practiced_ts, updated_at
       ) VALUES (@anon_user_id, @kp_key, @kp_text, @level, @attempts, @correct, @correct_streak, @last_practiced_ts, datetime('now'))
       ON CONFLICT(anon_user_id, kp_key) DO UPDATE SET
         kp_text = excluded.kp_text,
         level = excluded.level,
         attempts = excluded.attempts,
         correct = excluded.correct,
         correct_streak = excluded.correct_streak,
         last_practiced_ts = excluded.last_practiced_ts,
         updated_at = datetime('now')`
    )
    .run(row);
}

/**
 * R14：取某练习题所属的知识点键与用户（用于判分后刷新掌握度）。
 * practice_items.kp_id 存的是 knowledge_point_id，可直接作为 kp_key。
 */
export function getPracticeKp(
  practice_id: string
): { anon_user_id: string; kp_id: string | null } | undefined {
  return getDb()
    .prepare('SELECT anon_user_id, kp_id FROM practice_items WHERE practice_id = ?')
    .get(practice_id) as
    | { anon_user_id: string; kp_id: string | null }
    | undefined;
}

/** R14：按知识点拉取该用户有序练习记录（用于计算连续答对）。 */
export function getPracticeByKp(
  anon_user_id: string,
  kp_key: string
): Array<{ is_correct: number | null; created_at: string }> {
  return getDb()
    .prepare(
      `SELECT is_correct, created_at FROM practice_items
       WHERE anon_user_id = ? AND kp_id = ?
       ORDER BY created_at ASC`
    )
    .all(anon_user_id, kp_key) as Array<{ is_correct: number | null; created_at: string }>;
}
