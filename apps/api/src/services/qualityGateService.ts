/**
 * 质量优化服务（G1 闸门 / B·C·D 分层 / 代理↔质量校准）。
 *
 * 设计要点：
 *  - scoreGate 为纯函数（输入指标→报告），便于单测无需 DB；
 *  - evaluateQualityGate 聚合 dashboardService(computeM1) + loopService(computeLoopHealth) +
 *    盲评覆盖，产出可发布判定；
 *  - classifyStratum 基于错误频率与错因把知识点分到 A/B/C/D，使正式盲评按层抽样；
 *  - calibrateQuality 把代理自报分按置信度收敛到先验，输出保守校准分（单调、不超 raw）。
 */
import {
  G1_GATE_THRESHOLDS,
  CALIBRATION_PRIOR,
  QUALITY_STRATA,
  STRATUM_LABELS,
  MISCONCEPTION_CAUSES,
  RARE_CAUSES,
  type QualityStratum,
} from '@aicorrection/shared';
import type {
  QualityScorecard,
  QualityCheck,
  StratumReport,
  StrataReportResponse,
  CalibrationRequest,
  CalibrationResponse,
} from '@aicorrection/shared';
import { computeM1 } from './dashboardService';
import { computeLoopHealth } from './loopService';
import {
  getKpErrorStats,
  getAttributionReviewStats,
  getReviewedKpKeys,
  type KpErrorStat,
} from '../models/qualityModel';

/** 闸门输入指标（与 G1_GATE_THRESHOLDS 的键对齐）。 */
export interface GateMetrics {
  approval_rate: number;
  three_item_rate: number;
  upload_fail_rate: number;
  completion_rate: number;
  review_coverage: number;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** 纯函数：对一组指标逐条判定并产出综合闸门报告。 */
export function scoreGate(metrics: GateMetrics, window = 'manual'): QualityScorecard {
  const defs = G1_GATE_THRESHOLDS;
  const checks: QualityCheck[] = [];

  const add = (
    key: keyof typeof defs,
    value: number
  ) => {
    const d = defs[key];
    const pass = d.comparator === 'min' ? value >= d.threshold : value <= d.threshold;
    checks.push({
      name: key,
      label: d.label,
      value: round4(value),
      comparator: d.comparator,
      threshold: d.threshold,
      pass,
      severity: d.severity,
      detail: pass
        ? `${d.label}达标（${d.comparator === 'min' ? '≥' : '≤'}${d.threshold}）`
        : `${d.label}不达标（${d.comparator === 'min' ? '需≥' : '需≤'}${d.threshold}，实际 ${round4(value)}）`,
    });
  };

  add('approval_rate', metrics.approval_rate);
  add('three_item_rate', metrics.three_item_rate);
  add('upload_fail_rate', metrics.upload_fail_rate);
  add('completion_rate', metrics.completion_rate);
  add('review_coverage', metrics.review_coverage);

  const blockers = checks.filter((c) => !c.pass && c.severity === 'blocker').map((c) => c.label);
  const warnings = checks.filter((c) => !c.pass && c.severity === 'warning').map((c) => c.label);

  // 综合分：每个检查按 severity 加权；通过得满分，失败得 0。
  const weight = (c: QualityCheck) => (c.severity === 'blocker' ? 2 : 1);
  const totalW = checks.reduce((s, c) => s + weight(c), 0);
  const earnedW = checks.reduce((s, c) => s + (c.pass ? weight(c) : 0), 0);
  const score = totalW > 0 ? round4(earnedW / totalW) : 0;

  return {
    passed: blockers.length === 0,
    score,
    readiness: blockers.length === 0 ? 'ship' : 'hold',
    checks,
    blockers,
    warnings,
    generated_at: new Date().toISOString(),
    window,
  };
}

/**
 * 聚合现有遥测，产出 G1 闸门报告。
 * 复用 computeM1（认可率/三件套/上传失败）、computeLoopHealth（完成率）、盲评覆盖。
 */
export function evaluateQualityGate(windowDays = 14): QualityScorecard {
  const m1 = computeM1(windowDays);
  const health = computeLoopHealth(windowDays);
  const review = getAttributionReviewStats();
  const reviewCoverage = review.total > 0 ? review.reviewed / review.total : 0;

  return scoreGate(
    {
      approval_rate: m1.approval_rate,
      three_item_rate: m1.three_item_rate,
      upload_fail_rate: m1.upload_fail_rate,
      completion_rate: health.completion_rate,
      review_coverage: round4(reviewCoverage),
    },
    m1.window
  );
}

// ----------------- B·C·D 分层 -----------------

/** 单知识点分层输入。 */
export interface StratumInput {
  error_count: number;
  dominant_cause: string | null;
}

/**
 * 分层规则（冻结、可测）：
 *  - D 干扰/陷阱：错误高频（≥10）且主导错因为常见误解（概念混淆/方法错误）
 *  - C 极端/罕见：错误低频（≤2）或主导错因为罕见错因（记忆缺漏/审题不清）
 *  - B 边界：错误中频（≥4）或主导错因为方法/计算类
 *  - A 通用：其余
 */
export function classifyStratum(s: StratumInput): QualityStratum {
  const misconception = !!s.dominant_cause && (MISCONCEPTION_CAUSES as readonly string[]).includes(s.dominant_cause);
  const rare = !!s.dominant_cause && (RARE_CAUSES as readonly string[]).includes(s.dominant_cause);
  if (s.error_count >= 10 && misconception) return 'D';
  if (s.error_count <= 2 || rare) return 'C';
  if (s.error_count >= 4 || misconception) return 'B';
  return 'A';
}

/** 全量知识点分层 + 各层盲评覆盖统计。 */
export function computeStrataReport(): StrataReportResponse {
  const stats: KpErrorStat[] = getKpErrorStats();
  const reviewed = getReviewedKpKeys();
  const tally: Record<QualityStratum, { kp: number; reviewed: number }> = {
    A: { kp: 0, reviewed: 0 },
    B: { kp: 0, reviewed: 0 },
    C: { kp: 0, reviewed: 0 },
    D: { kp: 0, reviewed: 0 },
  };

  for (const st of stats) {
    const stratum = classifyStratum({ error_count: st.error_count, dominant_cause: st.dominant_cause });
    tally[stratum].kp += 1;
    if (reviewed.has(st.kp_key)) tally[stratum].reviewed += 1;
  }

  const items: StratumReport[] = (QUALITY_STRATA as readonly QualityStratum[]).map((stratum) => {
    const t = tally[stratum];
    return {
      stratum,
      label: STRATUM_LABELS[stratum],
      kp_count: t.kp,
      reviewed_count: t.reviewed,
      coverage: t.kp > 0 ? round4(t.reviewed / t.kp) : 0,
    };
  });

  return { items, total_kp: stats.length };
}

// ----------------- 代理↔质量校准 -----------------

/**
 * 校准：代理自报分按置信度向先验收敛。
 *   calibrated = confidence * raw + (1 - confidence) * prior
 * 性质：
 *  - 对 raw 与 confidence 均单调递增；
 *  - confidence=1 时 calibrated=raw（完全信任代理）；confidence=0 时 calibrated=prior（不信任）；
 *  - 因 prior=0.5 且 raw∈[0,1]，calibrated 不会系统性超过 raw（保守）。
 */
export function calibrateQuality(req: CalibrationRequest): CalibrationResponse {
  const raw = clamp01(req.raw_score);
  const confidence = clamp01(req.confidence);
  const calibrated = round4(confidence * raw + (1 - confidence) * CALIBRATION_PRIOR);
  return {
    raw_score: raw,
    confidence,
    prior: CALIBRATION_PRIOR,
    calibrated,
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
