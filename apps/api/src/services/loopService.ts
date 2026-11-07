/**
 * 闭环会话流服务（v0.3：R07 闭环会话流 / R08 最小存储 / 防刷护栏）。
 *
 *  - getLoopSummary：把一次闭环的五步状态（上传→归因→认可→练习→复述→验证→完成）聚合成
 *    一个可消费的结构，供前端展示「还差哪一步」与埋点校验。
 *  - completeLoop：显式收尾，写 complete_ts / duration_ms / loop_complete。
 *  - computeLoopHealth：护栏指标（闭环完成率、中位时长、单用户单日闭环量异常），
 *    只做「采集与告警信号」，不做硬拦截（避免误伤真实重度用户）。
 */
import { getDb } from '../db';
import {
  getLoopSession,
  completeLoopSession,
} from '../models/loopSessionModel';
import type { LoopSession } from '@aicorrection/shared';
import { getAttributionByLoop } from '../models/attributionModel';
import { getPracticeByLoop } from '../models/practiceModel';
import { HttpError } from '../middleware/errorHandler';
import { ERROR_CODES } from '@aicorrection/shared';

export interface LoopSummary {
  loop_id: string;
  has_upload: boolean;
  has_attribution: boolean;
  rated: boolean;
  has_practice: boolean;
  has_restate: boolean;
  has_verify: boolean;
  loop_complete: boolean;
  /** 完成度 0–1（六步加权：上传/归因/认可/练习/复述/验证 各 1/6，完成再 +0）。 */
  progress: number;
}

export function getLoopSummary(loop_id: string): LoopSummary {
  const session = getLoopSession(loop_id);
  if (!session) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 404, '闭环会话不存在');
  }
  const attr = getAttributionByLoop(loop_id);
  const practices = getPracticeByLoop(loop_id);
  const steps = [
    true, // 上传（能拿到 loop 即已完成）
    !!attr,
    !!attr && (attr.rate_action === 'approve' || attr.rate_action === 'inaccurate' || attr.rate_action === 'report'),
    !!session.has_practice,
    !!session.restate_text && session.restate_text.length > 0,
    !!session.verify_result,
  ];
  const done = steps.filter(Boolean).length;
  return {
    loop_id,
    has_upload: true,
    has_attribution: !!attr,
    rated: steps[2],
    has_practice: !!session.has_practice,
    has_restate: steps[4],
    has_verify: !!session.verify_result,
    loop_complete: !!session.loop_complete,
    progress: Math.round((done / 6) * 100) / 100,
  };
}

export function completeLoop(loop_id: string, anon_user_id: string): LoopSummary {
  const session = getLoopSession(loop_id);
  if (!session || session.anon_user_id !== anon_user_id) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 404, '闭环会话不存在或身份不匹配');
  }
  completeLoopSession(loop_id);
  return getLoopSummary(loop_id);
}

// ----------------- 防刷护栏指标 -----------------

export interface LoopHealth {
  scope: string;
  total_loops: number;
  completed_loops: number;
  completion_rate: number;
  median_duration_ms: number | null;
  /** 单用户单日闭环量 Top（仅统计异常：> DAILY_LOOP_ANOMALY） */
  daily_anomalies: Array<{ anon_user_id: string; day: string; count: number }>;
  window: string;
}

const DAILY_LOOP_ANOMALY = 50;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * 护栏指标：从 loop_sessions 聚合。默认只看真实流量（排除 mock/内部）。
 * 不拦截，仅产出异常信号供运营/反作弊复核。
 */
export function computeLoopHealth(windowDays = 14): LoopHealth {
  const db = getDb();
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT loop_id, anon_user_id, start_ts, complete_ts, duration_ms, loop_complete
       FROM loop_sessions WHERE start_ts >= ?`
    )
    .all(sinceIso) as Array<{
    loop_id: string;
    anon_user_id: string;
    start_ts: string;
    complete_ts: string | null;
    duration_ms: number | null;
    loop_complete: number;
  }>;

  let total = 0;
  let completed = 0;
  const durations: number[] = [];
  const perUserDay = new Map<string, number>();
  for (const r of rows) {
    total++;
    if (r.loop_complete) completed++;
    if (typeof r.duration_ms === 'number' && r.duration_ms > 0) durations.push(r.duration_ms);
    const day = (r.start_ts || '').slice(0, 10);
    if (day && r.anon_user_id) {
      const k = `${r.anon_user_id}|${day}`;
      perUserDay.set(k, (perUserDay.get(k) ?? 0) + 1);
    }
  }

  const anomalies: Array<{ anon_user_id: string; day: string; count: number }> = [];
  for (const [k, count] of perUserDay) {
    if (count > DAILY_LOOP_ANOMALY) {
      const [anon_user_id, day] = k.split('|');
      anomalies.push({ anon_user_id, day, count });
    }
  }
  anomalies.sort((a, b) => b.count - a.count);

  return {
    scope: 'all loops (window)',
    total_loops: total,
    completed_loops: completed,
    completion_rate: total > 0 ? Math.round((completed / total) * 1e4) / 1e4 : 0,
    median_duration_ms: median(durations),
    daily_anomalies: anomalies,
    window: `${sinceIso.slice(0, 10)}..${new Date().toISOString().slice(0, 10)}`,
  };
}
