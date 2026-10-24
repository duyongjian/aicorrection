/**
 * 埋点全局 Context + 事件 Schema（前后端共用）
 * 对齐：架构设计文档 §3.3 / 埋点方案 §1.2 / §2
 */
import type { Segment, Platform, ExpGroup } from './constants';

/** 渠道来源 */
export const CHANNELS = ['organic', 'referral', 'app_store', 'web', 'qr'] as const;
export type Channel = (typeof CHANNELS)[number];

/** ScreenView 页面枚举（§13 K1.2b） */
export const SCREEN_VIEW_PAGES = [
  'upload',       // P0: 上传页（激活）
  'attr_show',    // P0: 归因展示页（激活）
  'followup',     // P0: 追问页（激活，与 attr_show 同页共享）
  'practice',     // P1: 练习页（PENDING）
  'restate',      // P1: 复述页（PENDING）
  'verify',       // P1: 验证页（PENDING）
  'review',       // P2: 复习页（PENDING）
  'dashboard',    // P2: 看板页（PENDING）
  'other',        // 兜底
] as const;
export type ScreenViewPage = (typeof SCREEN_VIEW_PAGES)[number];

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
