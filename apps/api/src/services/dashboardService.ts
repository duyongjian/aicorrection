/**
 * 看板服务（QAL-02）
 * 按埋点方案口径从 analytics_events 聚合 M1 闸门指标：
 *   approval_rate        = count(attr_rate=approve 的 loop) / count(loop_attr_show 的 loop)
 *   three_item_rate      = count(attr_has_three=true) / count(loop_attr_show)
 *   upload_to_attr_latency_ms = loop_attr_show.attr_latency_ms 的 p50/p95
 *   upload_fail_rate     = count(loop_upload.ocr_status=fail) / count(loop_upload)
 *   gate                 = approval_rate >= 0.70 → go
 */
import { getDb } from '../db';
import {
  EVENT_NAMES,
  M1_APPROVAL_GATE,
  isUploadFailureStage,
  isUploadFailureReason,
} from '@aicorrection/shared';
import type {
  M1Stats,
  UploadFailureBreakdown,
  UploadFailureBucket,
} from '@aicorrection/shared';
import { computeLoopHealth, type LoopHealth } from './loopService';

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function computeM1(windowDays = 14): M1Stats {
  const db = getDb();
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const rows = db
    .prepare(
      `SELECT event_name, props_json, loop_id, ts_utc FROM analytics_events WHERE ts_utc >= ?`
    )
    .all(sinceIso) as Array<{
    event_name: string;
    props_json: string;
    loop_id: string | null;
    ts_utc: string;
  }>;

  // 闭环归属以 context.loop_id 为准（落库时已从 context 提取到 loop_id 列）。
  const attrShowLoops = new Set<string>();
  const approveLoops = new Set<string>();
  const latencyValues: number[] = [];
  let uploadTotal = 0;
  let uploadFail = 0;
  let threeTrue = 0;
  let attrShowTotal = 0;

  for (const r of rows) {
    const props = safeParse(r.props_json) ?? {};
    const loopId = typeof r.loop_id === 'string' ? r.loop_id : undefined;

    if (r.event_name === EVENT_NAMES.LOOP_ATTR_SHOW) {
      attrShowTotal++;
      if (loopId) attrShowLoops.add(loopId);
      if (props['attr_has_three'] === true) threeTrue++;
      if (typeof props['attr_latency_ms'] === 'number') {
        latencyValues.push(props['attr_latency_ms'] as number);
      }
    } else if (r.event_name === EVENT_NAMES.ATTR_RATE) {
      if (props['rate_action'] === 'approve' && loopId) {
        approveLoops.add(loopId);
      }
    } else if (r.event_name === EVENT_NAMES.LOOP_UPLOAD) {
      uploadTotal++;
      if (props['ocr_status'] === 'fail') uploadFail++;
    }
  }

  const approvalRate =
    attrShowLoops.size > 0 ? approveLoops.size / attrShowLoops.size : 0;
  const threeItemRate =
    attrShowTotal > 0 ? threeTrue / attrShowTotal : 1;
  const uploadFailRate = uploadTotal > 0 ? uploadFail / uploadTotal : 0;

  const windowStart = sinceIso.slice(0, 10);
  const windowEnd = new Date().toISOString().slice(0, 10);

  return {
    approval_rate: round(approvalRate),
    three_item_rate: round(threeItemRate),
    upload_to_attr_latency_ms: {
      p50: Math.round(percentile(latencyValues, 50)),
      p95: Math.round(percentile(latencyValues, 95)),
    },
    upload_fail_rate: round(uploadFailRate),
    window: `${windowStart}..${windowEnd}`,
    gate: approvalRate >= M1_APPROVAL_GATE ? 'go' : 'no-go',
  };
}

/** 计数 Map → 稳定排序的桶数组（count 降序、key 升序），便于报告直接消费。 */
function toBuckets(m: Map<string, number>): UploadFailureBucket[] {
  return [...m.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

/**
 * 上传失败细分诊断（v0.1.x 增量，GET /dashboard/upload-failures）。
 *
 * 口径纪律：
 *  - `m5` 段逐字复现 M1 的正式口径（分母 loop_upload 总数、分子 ocr_status='fail'），**不改变**；
 *  - `attempt_*` 是新增诊断口径：终态事件互斥（loop_upload 或 upload_fail 二选一），
 *    故 attempt_total = loop_upload + upload_fail；failure_total = ocr_fail + upload_fail；
 *  - 只统计真实流量 `is_mock=0 AND is_internal=0`（与 K1.5 §2 一致）；
 *  - stage='ocr' 由 loop_upload.ocr_status='fail' 合成，其余来自 upload_fail 的受控枚举，
 *    未知/缺失值统一归 'unknown'，绝不把自由文本写进分析。
 */
export function computeUploadFailureBreakdown(
  windowDays = 14
): UploadFailureBreakdown {
  const db = getDb();
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT event_name, props_json FROM analytics_events
       WHERE ts_utc >= ?
         AND is_mock = 0 AND is_internal = 0
         AND event_name IN (?, ?)`
    )
    .all(sinceIso, EVENT_NAMES.LOOP_UPLOAD, EVENT_NAMES.UPLOAD_FAIL) as Array<{
    event_name: string;
    props_json: string;
  }>;

  let loopTotal = 0;
  let ocrFail = 0;
  let uploadFailTotal = 0;
  const byStage = new Map<string, number>();
  const byReason = new Map<string, number>();
  const byStageReason = new Map<string, number>();

  for (const r of rows) {
    const props = safeParse(r.props_json) ?? {};
    if (r.event_name === EVENT_NAMES.LOOP_UPLOAD) {
      loopTotal++;
      if (props['ocr_status'] === 'fail') {
        ocrFail++;
        bump(byStage, 'ocr');
        bump(byReason, 'ocr_fail');
        bump(byStageReason, 'ocr|ocr_fail');
      }
      continue;
    }
    uploadFailTotal++;
    const stage: string = isUploadFailureStage(props['failure_stage'])
      ? props['failure_stage']
      : 'unknown';
    const reason: string = isUploadFailureReason(props['failure_reason'])
      ? props['failure_reason']
      : 'unknown';
    bump(byStage, stage);
    bump(byReason, reason);
    bump(byStageReason, `${stage}|${reason}`);
  }

  const attemptTotal = loopTotal + uploadFailTotal;
  const failureTotal = ocrFail + uploadFailTotal;
  const windowStart = sinceIso.slice(0, 10);
  const windowEnd = new Date().toISOString().slice(0, 10);

  return {
    window: `${windowStart}..${windowEnd}`,
    scope: 'is_mock=0 AND is_internal=0',
    attempt_total: attemptTotal,
    failure_total: failureTotal,
    attempt_failure_rate: round(attemptTotal > 0 ? failureTotal / attemptTotal : 0),
    m5: {
      loop_upload_total: loopTotal,
      ocr_fail: ocrFail,
      upload_fail_rate: round(loopTotal > 0 ? ocrFail / loopTotal : 0),
    },
    by_stage: toBuckets(byStage),
    by_reason: toBuckets(byReason),
    by_stage_reason: toBuckets(byStageReason),
  };
}

/** v0.3 防刷护栏：闭环健康度（完成率/中位时长/单日异常），仅采集信号不拦截。 */
export function computeLoopHealthSafe(windowDays = 14): LoopHealth {
  return computeLoopHealth(windowDays);
}
