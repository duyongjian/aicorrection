/**
 * attributions 数据访问层（ATT-02 / ATT-04 / QAL-01）
 */
import { getDb } from '../db';
import type {
  Attribution,
  InaccurateReason,
  RateAction,
  ReviewPendingItem,
} from '@aicorrection/shared';

export function createAttribution(attribution: Attribution): void {
  getDb()
    .prepare(
      `INSERT INTO attributions (
        attribution_id, loop_id, anon_user_id, mistake_id,
        cause, knowledge_point, essence, attr_model_version, attr_latency_ms,
        rate_action, inaccurate_reason, expert_consistency, expert_accuracy
      ) VALUES (
        @attribution_id, @loop_id, @anon_user_id, @mistake_id,
        @cause, @knowledge_point, @essence, @attr_model_version, @attr_latency_ms,
        @rate_action, @inaccurate_reason, @expert_consistency, @expert_accuracy
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
