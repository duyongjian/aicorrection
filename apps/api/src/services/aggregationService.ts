/**
 * 聚合服务（P1：R09 错因聚合 / R10 薄弱点可视化 / R14 掌握判定）。
 *
 * 设计取舍：
 *  - 所有聚合均为只读 SQL + 内存归并，确定性、可单测、无外部依赖；
 *  - R14 掌握度状态机由 practice_items 的真实作答推导（attempts/correct/连续答对），
 *    不回传任何作答内容到外部模型（数据主权）；
 *  - master_state 以 (anon_user_id, kp_key) 为键幂等 upsert；GET 接口先重算再返回，
 *    保证无后台任务也能拿到最新掌握度。
 */
import {
  getCauseCounts,
  getKpCauseDetail,
  getPracticeStatsByKp,
  getMastery,
  getAllMastery,
  upsertMastery,
  getPracticeKp,
  getPracticeByKp,
} from '../models/aggregationModel';
import { scheduleReview } from './reviewScheduleService';
import { CAUSE_TAXONOMY, MASTERY_LABELS, type MasteryLevel } from '@aicorrection/shared';
import type {
  CauseAggregationResponse,
  CauseAggregationItem,
  WeakPointsResponse,
  WeakPointItem,
  MasteryState,
  MasteryListResponse,
} from '@aicorrection/shared';

// ----------------- R09 错因聚合 -----------------

export function getCauseAggregation(anon_user_id: string): CauseAggregationResponse {
  const rows = getCauseCounts(anon_user_id);
  const total = rows.reduce((s, r) => s + r.count, 0);
  const items: CauseAggregationItem[] = rows
    .map((r) => ({
      cause_id: r.cause_id as CauseAggregationItem['cause_id'],
      cause_label: CAUSE_TAXONOMY[r.cause_id as keyof typeof CAUSE_TAXONOMY] ?? r.cause_id,
      count: r.count,
      pct: total > 0 ? Math.round((r.count / total) * 1e4) / 1e4 : 0,
    }))
    .sort((a, b) => b.count - a.count || a.cause_id.localeCompare(b.cause_id));

  return { anon_user_id, total, items };
}

// ----------------- R10 薄弱点可视化 -----------------

/**
 * 合并三类信号得到薄弱点列表：
 *  1) attributions 按 kp 的错误数 + 错因分布（top_cause）；
 *  2) practice_items 按 kp 的练习数 + 答对数；
 *  3) mastery_state 的掌握等级。
 * 排序：错误数降序，并列时掌握等级升序（越没掌握越靠前）。
 */
export function getWeakPoints(anon_user_id: string): WeakPointsResponse {
  const details = getKpCauseDetail(anon_user_id);
  const practice = getPracticeStatsByKp(anon_user_id);
  const masteryRows = getAllMastery(anon_user_id);
  const masteryByKp = new Map<string, MasteryLevel>(
    masteryRows.map((m) => [m.kp_key, m.level])
  );
  const practiceByKp = new Map(practice.map((p) => [p.kp_id, p]));

  // 归并：kp_key -> { kp_text, error_count, causeCount: Map<cause, n> }
  const acc = new Map<
    string,
    { kp_text: string; error_count: number; causeCount: Map<string, number> }
  >();
  for (const d of details) {
    const key = d.kp_key;
    if (!acc.has(key)) {
      acc.set(key, { kp_text: d.kp_text, error_count: 0, causeCount: new Map() });
    }
    const e = acc.get(key)!;
    e.error_count += d.cnt;
    if (d.cause_id) {
      e.causeCount.set(d.cause_id, (e.causeCount.get(d.cause_id) ?? 0) + d.cnt);
    }
  }

  const items: WeakPointItem[] = [...acc.entries()].map(([kp_key, e]) => {
    let top_cause: string | null = null;
    let topN = 0;
    for (const [c, n] of e.causeCount) {
      if (n > topN) {
        topN = n;
        top_cause = c;
      }
    }
    const pr = practiceByKp.get(kp_key);
    return {
      kp_key,
      kp_text: e.kp_text,
      error_count: e.error_count,
      practice_count: pr ? pr.attempts : 0,
      mastery_level: masteryByKp.get(kp_key) ?? 'not_started',
      top_cause: (top_cause as WeakPointItem['top_cause']) ?? null,
      top_cause_label:
        top_cause && top_cause in CAUSE_TAXONOMY
          ? CAUSE_TAXONOMY[top_cause as keyof typeof CAUSE_TAXONOMY]
          : null,
    } satisfies WeakPointItem;
  });

  const levelRank: Record<MasteryLevel, number> = {
    not_started: 0,
    learning: 1,
    familiar: 2,
    mastered: 3,
  };
  items.sort(
    (a, b) =>
      b.error_count - a.error_count ||
      levelRank[a.mastery_level] - levelRank[b.mastery_level] ||
      a.kp_text.localeCompare(b.kp_text)
  );

  return { anon_user_id, items };
}

// ----------------- R14 掌握判定状态机 -----------------

/** 由有序练习记录推导连续答对（streak = 以最近一次作答为结尾的连续正确数）。 */
function computeStreak(records: Array<{ is_correct: number | null }>): number {
  let streak = 0;
  for (const r of records) {
    if (r.is_correct === 1) streak++;
    else if (r.is_correct === 0) streak = 0;
    // is_correct IS NULL（LLM 题未判分）不破坏既有 streak，也不增加
  }
  return streak;
}

/** 状态机：根据累计答对与连续答对推导等级。 */
export function deriveMasteryLevel(attempts: number, correct: number, streak: number): MasteryLevel {
  if (attempts === 0) return 'not_started';
  if (streak >= 3) return 'mastered';
  if (correct >= 2) return 'familiar';
  return 'learning';
}

/**
 * 重算并写回单个知识点的掌握状态。
 * 若 kp_key 对应的 practice_items 为空，则回退到 not_started（保留 kp_text）。
 */
export function recomputeMastery(
  anon_user_id: string,
  kp_key: string,
  kp_text: string
): MasteryState {
  const records = getPracticeByKp(anon_user_id, kp_key);
  const attempts = records.length;
  let correct = 0;
  for (const r of records) if (r.is_correct === 1) correct++;
  const streak = computeStreak(records);
  const level = deriveMasteryLevel(attempts, correct, streak);
  const lastTs = records.length ? records[records.length - 1].created_at : null;

  const row: MasteryState = {
    anon_user_id,
    kp_key,
    kp_text,
    level,
    attempts,
    correct,
    correct_streak: streak,
    last_practiced_ts: lastTs ? new Date(lastTs.replace(' ', 'T') + 'Z').toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  upsertMastery(row);
  return row;
}

/** 判分后调用：刷新某练习题所属知识点的掌握状态（无 kp 归属则不动作）。 */
export function refreshMasteryForPractice(practice_id: string): MasteryState | null {
  const pk = getPracticeKp(practice_id);
  if (!pk || !pk.kp_id) return null;
  const state = recomputeMastery(pk.anon_user_id, pk.kp_id, pk.kp_id);
  // R15：掌握度升到 familiar/mastered 时，自动排程一次间隔复习（已排程则不重置）
  if (state.level === 'familiar' || state.level === 'mastered') {
    try {
      scheduleReview(pk.anon_user_id, pk.kp_id, pk.kp_id);
    } catch {
      /* 复习排程为增强指标，异常不阻断判分主流程 */
    }
  }
  return state;
}

/** 重算并返回某用户全部知识点的掌握状态。 */
export function refreshAllMastery(anon_user_id: string): MasteryListResponse {
  const details = getKpCauseDetail(anon_user_id);
  const seen = new Set<string>();
  for (const d of details) {
    if (!seen.has(d.kp_key)) {
      seen.add(d.kp_key);
      recomputeMastery(anon_user_id, d.kp_key, d.kp_text);
    }
  }
  const rows = getAllMastery(anon_user_id) as MasteryState[];
  return { anon_user_id, items: rows };
}

/** 读取单个知识点掌握状态（无记录则返回默认 not_started）。 */
export function getMasteryState(
  anon_user_id: string,
  kp_key: string
): MasteryState {
  const existing = getMastery(anon_user_id, kp_key);
  if (existing) {
    return {
      ...existing,
      kp_text: existing.kp_text ?? kpKeyToText(kp_key),
    };
  }
  return {
    anon_user_id,
    kp_key,
    kp_text: kpKeyToText(kp_key),
    level: 'not_started',
    attempts: 0,
    correct: 0,
    correct_streak: 0,
    last_practiced_ts: null,
    updated_at: new Date().toISOString(),
  };
}

function kpKeyToText(kpKey: string): string {
  if (kpKey.startsWith('txt:')) return kpKey.slice(4);
  return kpKey;
}

// 仅用于避免未使用告警（MASTERY_LABELS 供测试/未来展示复用）
void MASTERY_LABELS;
