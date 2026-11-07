/**
 * 全局共享常量（前后端共用）
 * 对齐：架构设计文档 §7.1 / §7.2 / 埋点方案 §1.2 / §2
 */

/** 客户端/协议版本（随 context 上报，支撑 A/B 与闸门分期） */
export const APP_VERSION = '0.1.0';

/** segment 代码（系统-of-record 用代码，展示用中文见 SEGMENT_LABELS） */
export const SEGMENTS = ['kaoyan', 'kaogong', 'gaozhong'] as const;
export type Segment = (typeof SEGMENTS)[number];

export const SEGMENT_LABELS: Record<Segment, string> = {
  kaoyan: '考研',
  kaogong: '考公',
  gaozhong: '高中',
};

/** 实验分组（H1 A/B 预埋） */
export const EXP_GROUPS = ['control', 'treatment', 'none'] as const;
export type ExpGroup = (typeof EXP_GROUPS)[number];
export const DEFAULT_EXP_GROUP: ExpGroup = 'none';

/** 平台 */
export const PLATFORMS = ['ios', 'android', 'web', 'mini'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** 上传来源 */
export const SRC_TYPES = ['photo', 'text', 'paste'] as const;
export type SrcType = (typeof SRC_TYPES)[number];

/** OCR 状态 */
export const OCR_STATUSES = ['success', 'partial', 'fail'] as const;
export type OcrStatus = (typeof OCR_STATUSES)[number];

/** 评分动作 */
export const RATE_ACTIONS = ['approve', 'inaccurate', 'report'] as const;
export type RateAction = (typeof RATE_ACTIONS)[number];

/** 不准确原因（R2 信任障碍根因） */
export const INACCURATE_REASONS = [
  'not_essence',
  'wrong_knowledge',
  'wrong_cause',
  'other',
] as const;
export type InaccurateReason = (typeof INACCURATE_REASONS)[number];

/** 追问角色 */
export const FOLLOWUP_ROLES = ['user_ask', 'ai_ask', 'user_answer'] as const;
export type FollowupRole = (typeof FOLLOWUP_ROLES)[number];

/** ID 前缀（§7.1） */
export const ID_PREFIX = {
  user: 'u_',
  loop: 'l_',
  mistake: 'm_',
  attribution: 'a_',
  session: 's_',
  review: 'r_',
} as const;

/** v0.1 业务事件名 */
export const EVENT_NAMES = {
  LOOP_UPLOAD: 'loop_upload',
  LOOP_ATTR_SHOW: 'loop_attr_show',
  ATTR_RATE: 'attr_rate',
  FOLLOWUP: 'followup',
  /** v0.1.x 增量：上传失败细分（诊断事件，不参与 G1/M5 正式口径） */
  UPLOAD_FAIL: 'upload_fail',
} as const;
export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

/** M1 闸门阈值（§7.2 假设阈值，待灰度回校） */
export const M1_APPROVAL_GATE = 0.7;

/** Mock 归因模型版本 */
export const MOCK_ATTR_MODEL_VERSION = 'mock-v1';

// ===================== 线下分发 MVP：卡密凭证契约 =====================

/** 业务请求携带凭证的 header（同时兼容 Authorization: Bearer，见 requireLicense） */
export const LICENSE_TOKEN_HEADER = 'x-license-token';

/** 前端保存凭证的 localStorage key */
export const LICENSE_TOKEN_STORAGE_KEY = 'aicorrection_license_token';

/**
 * 仅供「上传原图回显」使用的 HttpOnly cookie 名。
 *
 * 背景：<img src="/api/v1/uploads/..."> 由浏览器直接发起，无法携带自定义 header，
 * 但门禁又不能为此对 uploads 匿名放行。兑换成功后由服务端下发此 cookie，
 * requireLicense 仅在 /uploads/* 路径接受它；其余业务接口一律只认 header，
 * 避免把 cookie 变成全站 CSRF 凭证。cookie 的 path 也收窄到 uploads 前缀。
 */
export const LICENSE_COOKIE_NAME = 'aicorrection_license';

/**
 * 既有匿名身份存储 key（apps/web/src/store/loopStore.ts 的 LS_KEY）。
 * 卡密兑换成功后必须写入这里，useLoop 才会复用已有 anon_user_id、
 * 不再调用公开的 POST /account，主流程因此零改动。
 */
export const ANON_USER_STORAGE_KEY = 'aicorrection_anon_user';
