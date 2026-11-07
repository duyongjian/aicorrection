/**
 * 质量模型（QAL）：读取归因/掌握的聚合信号，供 G1 闸门与 B·C·D 分层使用。
 * 纯只读查询，不写入任何质量结论（结论由 qualityGateService 计算）。
 */
import { getDb } from '../db';

/** 知识点错误统计：错误次数 + 主导错因（出现最多的 cause_id）。 */
export interface KpErrorStat {
  kp_key: string;
  error_count: number;
  dominant_cause: string | null;
}

export function getKpErrorStats(): KpErrorStat[] {
  return getDb()
    .prepare(
      `SELECT knowledge_point_id AS kp_key,
              COUNT(*) AS error_count,
              (SELECT cause_id FROM attributions a2
                WHERE a2.knowledge_point_id = a1.knowledge_point_id
                GROUP BY cause_id ORDER BY COUNT(*) DESC, cause_id LIMIT 1) AS dominant_cause
       FROM attributions a1
       WHERE knowledge_point_id IS NOT NULL
       GROUP BY knowledge_point_id`
    )
    .all() as KpErrorStat[];
}

/** 错因分布计数（用于判定「罕见错因」）。 */
export function getCauseCounts(): Array<{ cause_id: string; count: number }> {
  return getDb()
    .prepare(
      `SELECT cause_id, COUNT(*) AS count FROM attributions
       WHERE cause_id IS NOT NULL GROUP BY cause_id`
    )
    .all() as Array<{ cause_id: string; count: number }>;
}

/** 盲评覆盖统计：总归因数 + 已盲评（expert_accuracy 非 NULL）数。 */
export interface ReviewStats {
  total: number;
  reviewed: number;
}

export function getAttributionReviewStats(): ReviewStats {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN expert_accuracy IS NOT NULL THEN 1 ELSE 0 END) AS reviewed
       FROM attributions`
    )
    .get() as { total: number; reviewed: number | null };
  return { total: row.total, reviewed: row.reviewed ?? 0 };
}

/** 每层的盲评覆盖：传入分层结果（kp_key→stratum），统计各层已盲评数。 */
export function getReviewedKpKeys(): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT knowledge_point_id AS kp_key FROM attributions
       WHERE knowledge_point_id IS NOT NULL AND expert_accuracy IS NOT NULL`
    )
    .all() as Array<{ kp_key: string }>;
  return new Set(rows.map((r) => r.kp_key));
}
