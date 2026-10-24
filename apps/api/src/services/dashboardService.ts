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
import { EVENT_NAMES, M1_APPROVAL_GATE } from '@aicorrection/shared';
import type { M1Stats } from '@aicorrection/shared';

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
