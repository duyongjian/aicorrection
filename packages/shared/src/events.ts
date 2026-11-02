/**
 * 埋点全局 Context + 事件 Schema（前后端共用）
 * 对齐：架构设计文档 §3.3 / 埋点方案 §1.2 / §2
 */
import type { Segment, Platform, ExpGroup } from './constants';

/** 渠道来源 */
export const CHANNELS = ['organic', 'referral', 'app_store', 'web', 'qr'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * ScreenView 页面枚举（§13 K1.2b · v0.1 冻结）
 *
 * 冻结规则（不可回溯）：
 * - ACTIVE：v0.1 允许上报的页面，只有 3 个（P0 主链路）。新增须走枚举变更评审。
 * - PENDING：UI 可能存在但 v0.1 一律不上报（practice/restate/verify 属 v0.2+ 范围）。
 *
 * 前端 SDK 必须用 isActiveScreenView() 做运行期校验，PENDING/未知一律丢弃。
 */
export const ACTIVE_SCREEN_VIEWS = ['upload', 'attr_show', 'followup'] as const;

export const PENDING_SCREEN_VIEWS = [
  'practice', // P1: 练习页（v0.2）
  'restate', // P1: 复述页（v0.2）
  'verify', // P1: 验证页（v0.2）
  'review', // P2: 复习页
  'dashboard', // P2: 看板页
  'other', // 兜底
] as const;

export const SCREEN_VIEW_PAGES = [
  ...ACTIVE_SCREEN_VIEWS,
  ...PENDING_SCREEN_VIEWS,
] as const;

export type ScreenViewPage = (typeof SCREEN_VIEW_PAGES)[number];
/** v0.1 实际可上报的页名（ACTIVE 子集） */
export type ActiveScreenViewPage = (typeof ACTIVE_SCREEN_VIEWS)[number];
export type ScreenViewStatus = 'active' | 'pending';

/** 单一真源：页名 → 状态。新增页必须在此登记，否则视为未知并丢弃。 */
export const SCREEN_VIEW_STATUS: Readonly<Record<ScreenViewPage, ScreenViewStatus>> = {
  upload: 'active',
  attr_show: 'active',
  followup: 'active',
  practice: 'pending',
  restate: 'pending',
  verify: 'pending',
  review: 'pending',
  dashboard: 'pending',
  other: 'pending',
};

/** 是否为已登记页名（含 PENDING） */
export function isScreenViewPage(v: unknown): v is ScreenViewPage {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SCREEN_VIEW_STATUS, v);
}

/** 是否为 v0.1 允许上报页名（仅 ACTIVE） */
export function isActiveScreenView(v: unknown): v is ActiveScreenViewPage {
  return isScreenViewPage(v) && SCREEN_VIEW_STATUS[v] === 'active';
}

/**
 * 校验并归一化 screen_view 页名。
 * @returns ok=true 时返回可上报页名；ok=false 时返回丢弃原因（供 SDK 告警）。
 */
export function validateScreenView(v: unknown):
  | { ok: true; page: ActiveScreenViewPage }
  | { ok: false; reason: 'unknown' | 'pending'; raw: unknown } {
  if (!isScreenViewPage(v)) return { ok: false, reason: 'unknown', raw: v };
  if (!isActiveScreenView(v)) return { ok: false, reason: 'pending', raw: v };
  return { ok: true, page: v };
}

/** 全局 Context（每个事件必带） */
export interface TrackContext {
  app_version: string;
  platform: Platform;
  user_id: string; // 匿名 ID（anon_user_id），不可逆
  segment: Segment;
  session_id: string;
  loop_id?: string; // 仅闭环相关事件携带
  ts_utc: string; // ISO8601 UTC，事件发生时间
  ts_send_utc?: string; // 上报时间
  event_seq: number; // 同 loop 内事件序号（无 loop 默认 1）
  exp_id?: string;
  exp_group: ExpGroup;
  /** 推荐渠道来源（organic/referral/app_store/web/qr 等） */
  channel?: Channel;
  /** UTM 参数：来源 */
  utm_source?: string;
  /** UTM 参数：活动 */
  utm_campaign?: string;
  /** 是否内部账号（服务端注入） */
  is_internal?: boolean;
  /** 是否 mock 模式（服务端注入） */
  is_mock?: boolean;
}

/** 事件信包 */
export interface TrackEvent {
  event_name: string;
  context: TrackContext;
  props: Record<string, unknown>;
  ts_utc: string;
}

// ===================== v0.1 四大业务事件 props =====================

export interface LoopUploadProps {
  src_type: 'photo' | 'text' | 'paste';
  ocr_status: 'success' | 'partial' | 'fail';
  retry_count: number;
  photo_blur: boolean;
  subject?: string;
  upload_duration_ms: number;
  loop_id: string; // 此处生成
}

export interface LoopAttrShowProps {
  attr_latency_ms: number;
  attr_has_three: boolean;
  attr_model_version: string;
  knowledge_point: string;
}

export interface AttrRateProps {
  rate_action: 'approve' | 'inaccurate' | 'report';
  rate_score?: number; // 1..5
  inaccurate_reason?: 'not_essence' | 'wrong_knowledge' | 'wrong_cause' | 'other';
  inaccurate_text?: string; // 默认不入分析库
}

export interface FollowupProps {
  followup_round: number; // 1,2
  followup_role: 'user_ask' | 'ai_ask' | 'user_answer';
  has_next_action: boolean;
}
