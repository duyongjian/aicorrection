/**
 * 间隔复习调度服务（P2：R15 间隔复习 / R16 复习列表 / R12 变式题）。
 * 与专家盲评服务 reviewService.ts 解耦（后者是 QAL-01 人工质检，本服务是用户侧复习闭环）。
 *
 * 设计取舍：
 *  - 复习计划（review_schedule）采用 SM-2 简化版：正确→间隔翻倍（封顶 30 天），错误→归 1 天；
 *    首次排程在 mastery 升级到 familiar/mastered 时由 learningService 触发（见 refreshMasteryForPractice）。
 *  - R15 复测**强制用变式题**（R12）：createReview 返回的是同一知识点下的"不同题"或通用变式提示，
 *    不回放原题（原题=测记忆，不是测掌握）。
 *  - 不回传任何作答内容到外部模型（数据主权）。
 */
import { randomBytes } from 'node:crypto';
import { HttpError } from '../middleware/errorHandler';
import {
  getReviewSchedule,
  getAllReviewSchedule,
  upsertReviewSchedule,
  insertReviewSession,
  updateReviewSessionReturn,
  getReviewSession,
} from '../models/reviewModel';
import { getQbankByKnowledgePoint, type PracticeItemSource } from '../models/practiceModel';
import { getLoopSession } from '../models/loopSessionModel';
import { ERROR_CODES } from '@aicorrection/shared';
import type {
  ReviewScheduleItem,
  DueReviewResponse,
  StartReviewResponse,
  CompleteReviewResponse,
} from '@aicorrection/shared';

const MAX_INTERVAL_DAYS = 30;

function addDaysIso(iso: string, days: number): string {
  const ms = new Date(iso).getTime() + days * 86_400_000;
  return new Date(ms).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 首次排程：仅当该 kp 尚无计划时创建（interval=1 天，明天到期）。已排程则不重置。 */
export function scheduleReview(
  anon_user_id: string,
  kp_key: string,
  kp_text: string | null
): ReviewScheduleItem {
  const existing = getReviewSchedule(anon_user_id, kp_key);
  if (existing) return existing;
  const next = addDaysIso(nowIso(), 1);
  const row: ReviewScheduleItem = {
    anon_user_id,
    kp_key,
    kp_text: kp_text ?? null,
    interval_days: 1,
    ease: 2.5,
    last_result: null,
    next_review_ts: next,
  };
  upsertReviewSchedule(row);
  return row;
}

/** 复测回流后刷新间隔（R15 核心状态转移）。 */
export function applyReviewResult(
  anon_user_id: string,
  kp_key: string,
  result: 'correct' | 'wrong' | 'skip'
): ReviewScheduleItem {
  const cur = getReviewSchedule(anon_user_id, kp_key);
  const baseInterval = cur?.interval_days ?? 1;
  let nextInterval = baseInterval;
  if (result === 'correct') nextInterval = Math.min(baseInterval * 2, MAX_INTERVAL_DAYS);
  else if (result === 'wrong') nextInterval = 1;
  // skip：保持当前间隔不变
  const row: ReviewScheduleItem = {
    anon_user_id,
    kp_key,
    kp_text: cur?.kp_text ?? null,
    interval_days: nextInterval,
    ease: cur?.ease ?? 2.5,
    last_result: result,
    next_review_ts: addDaysIso(nowIso(), nextInterval),
  };
  upsertReviewSchedule(row);
  return row;
}

/** R16 复习列表：返回该用户全部复习计划，并标记是否到期（is_due）。 */
export function getDueReviewsList(anon_user_id: string): DueReviewResponse {
  const now = nowIso();
  const rows = getAllReviewSchedule(anon_user_id);
  const items = rows.map((r) => ({
    ...r,
    is_due: r.next_review_ts == null || r.next_review_ts <= now,
  }));
  return { anon_user_id, items };
}

/** R12 变式题：取同一知识点下"不同"的题库题作为复测题；无题库则回退通用变式提示。 */
export function generateVariant(kp_text: string | null): { question_text: string; source: 'variant' | 'generic' } {
  if (kp_text) {
    const candidates: PracticeItemSource[] = getQbankByKnowledgePoint(kp_text);
    if (candidates.length > 0) {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      return { question_text: pick.question_text, source: 'variant' };
    }
  }
  return {
    question_text: `（变式）请重新做一道与「${kp_text || '本知识点'}」相关的题目，并写出关键步骤与易错点。`,
    source: 'generic',
  };
}

/** R15 发起一次复测：创建 review_session（is_variant=1）并返回变式题。 */
export function createReview(
  anon_user_id: string,
  kp_key: string,
  kp_text?: string | null,
  source_loop_id?: string | null
): StartReviewResponse {
  const sched = getReviewSchedule(anon_user_id, kp_key);
  const text = kp_text ?? sched?.kp_text ?? null;
  const variant = generateVariant(text);
  const review_id = `r-${randomBytes(12).toString('hex')}`;
  insertReviewSession({
    review_id,
    anon_user_id,
    source_loop_id: source_loop_id ?? null,
    target_kp: kp_key,
    push_ts: nowIso(),
    is_variant: 1,
  });
  return {
    review_id,
    kp_key,
    kp_text: text,
    question_text: variant.question_text,
    is_variant: 1,
    source: variant.source,
  };
}

/** R15 完成复测：写回流结果 + 刷新复习间隔。返回下次复习时间。 */
export function completeReview(
  review_id: string,
  retest_result: 'correct' | 'wrong' | 'skip'
): CompleteReviewResponse {
  const session = getReviewSession(review_id);
  if (!session) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 404, '复测记录不存在');
  }
  let daysSince = null as number | null;
  if (session.source_loop_id) {
    const loop = getLoopSession(session.source_loop_id);
    if (loop?.start_ts) {
      const startMs = new Date(loop.start_ts.replace(' ', 'T') + 'Z').getTime();
      if (Number.isFinite(startMs)) {
        daysSince = Math.max(0, Math.round((Date.now() - startMs) / 86_400_000));
      }
    }
  }
  updateReviewSessionReturn(review_id, nowIso(), daysSince, retest_result);
  const updated = applyReviewResult(session.anon_user_id, session.target_kp, retest_result);
  return {
    review_id,
    retest_result,
    next_review_ts: updated.next_review_ts,
    interval_days: updated.interval_days,
  };
}
