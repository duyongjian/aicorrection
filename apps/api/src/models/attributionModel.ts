/**
 * attributions 数据访问层（ATT-02 / ATT-04 / QAL-01）
 */
import { getDb } from '../db';
import { env } from '../config/env';
import type {
  Attribution,
  HistoryItem,
  InaccurateReason,
  RateAction,
  ReviewPendingItem,
} from '@aicorrection/shared';

export function createAttribution(attribution: Attribution): void {
  getDb()
    .prepare(
      `INSERT INTO attributions (
        attribution_id, loop_id, anon_user_id, mistake_id,
        question, user_answer,
        cause, knowledge_point, essence, correct_answer, derivation, pitfalls,
        attr_model_version, attr_latency_ms,
        rate_action, inaccurate_reason, expert_consistency, expert_accuracy,
        knowledge_point_id, cause_id, kq_taxonomy_version, cause_taxonomy_version,
        is_mock, is_internal, rollout_group
      ) VALUES (
        @attribution_id, @loop_id, @anon_user_id, @mistake_id,
        @question, @user_answer,
        @cause, @knowledge_point, @essence, @correct_answer, @derivation, @pitfalls,
        @attr_model_version, @attr_latency_ms,
        @rate_action, @inaccurate_reason, @expert_consistency, @expert_accuracy,
        @knowledge_point_id, @cause_id, @kq_taxonomy_version, @cause_taxonomy_version,
        @is_mock, @is_internal, @rollout_group
      )`
    )
    .run(attribution);
}

export function getAttributionByLoop(loop_id: string): Attribution | undefined {
  return getDb()
    .prepare(
      'SELECT * FROM attributions WHERE loop_id = ? ORDER BY created_at DESC LIMIT 1'
    )
    .get(loop_id) as Attribution | undefined;
}

export function getAttribution(
  attribution_id: string
): Attribution | undefined {
  return getDb()
    .prepare('SELECT * FROM attributions WHERE attribution_id = ?')
    .get(attribution_id) as Attribution | undefined;
}

/**
 * 按用户列出最近归因（FLW-02）：LEFT JOIN mistakes 取学科/来源/原图引用，
 * 不依赖内存态，跨会话可查。image_url 由路由层按 src_type/mistake_ref 拼接。
 */
export function listAttributionsByUser(
  anon_user_id: string,
  limit = 50
): HistoryItem[] {
  const rows = getDb()
    .prepare(
      `SELECT a.attribution_id, a.loop_id, a.anon_user_id, a.cause, a.knowledge_point,
              a.essence, a.correct_answer, a.derivation, a.pitfalls,
              a.attr_model_version, a.attr_latency_ms, a.rate_action, a.created_at,
              m.subject, m.src_type, m.mistake_ref
       FROM attributions a
       LEFT JOIN mistakes m ON a.mistake_id = m.mistake_id
       WHERE a.anon_user_id = ?
       ORDER BY a.created_at DESC
       LIMIT ?`
    )
    .all(anon_user_id, limit) as Array<HistoryItem & { mistake_ref: string | null }>;
  return rows.map((r) => ({
    attribution_id: r.attribution_id,
    loop_id: r.loop_id,
    anon_user_id: r.anon_user_id,
    cause: r.cause,
    knowledge_point: r.knowledge_point,
    essence: r.essence,
    correct_answer: r.correct_answer,
    derivation: r.derivation,
    pitfalls: r.pitfalls,
    attr_model_version: r.attr_model_version,
    attr_latency_ms: r.attr_latency_ms,
    rate_action: r.rate_action,
    created_at: r.created_at,
    subject: r.subject,
    src_type: r.src_type,
    image_url:
      r.src_type === 'photo' && r.mistake_ref && !r.mistake_ref.startsWith('hash:')
        ? `${env.API_BASE_PATH}/uploads/${r.mistake_ref}`
        : null,
  }));
}

export function updateRateAction(
  loop_id: string,
  rate_action: RateAction,
  inaccurate_reason?: InaccurateReason | null
): { found: boolean } {
  const info = getDb()
    .prepare(
      `UPDATE attributions SET rate_action = ?, inaccurate_reason = ?
       WHERE loop_id = ?`
    )
    .run(rate_action, inaccurate_reason ?? null, loop_id);
  return { found: info.changes > 0 };
}

export function updateExpert(
  attribution_id: string,
  expert_accuracy: 'accurate' | 'inaccurate',
  expert_consistency: 'agree' | 'disagree' | null
): void {
  getDb()
    .prepare(
      `UPDATE attributions SET expert_accuracy = ?, expert_consistency = ?
       WHERE attribution_id = ?`
    )
    .run(expert_accuracy, expert_consistency, attribution_id);
}

export function getPendingReviews(
  limit: number,
  onlyUnrated: boolean
): ReviewPendingItem[] {
  const sql = onlyUnrated
    ? `SELECT attribution_id, loop_id, cause, knowledge_point, essence, attr_model_version
       FROM attributions WHERE expert_accuracy IS NULL
       ORDER BY created_at DESC LIMIT ?`
    : `SELECT attribution_id, loop_id, cause, knowledge_point, essence, attr_model_version
       FROM attributions ORDER BY created_at DESC LIMIT ?`;
  return getDb().prepare(sql).all(limit) as ReviewPendingItem[];
}
