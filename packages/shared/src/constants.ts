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
  followup: 'fu_',
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

// ===================== 真实账号体系（v0.2 地基）：auth 凭证契约 =====================
//
// 设计原则：anon_user_id 仍是系统内唯一身份主键（错题/归因/闭环/埋点全依赖它），
// 真实账号只是挂在 anon_user_id 上的一个「可链接凭证层」——
// 邮箱/手机/微信/magic 任一方式登录后都解析回同一个 anon_user_id。
// 因此老匿名用户、卡密用户的数据与身份流完全不变，新账号体系纯增量接入。

/** 业务请求携带真实账号凭证的 header（同时兼容 Authorization: Bearer，见 requireLicense） */
export const AUTH_TOKEN_HEADER = 'x-auth-token';

/** 前端保存真实账号凭证的 localStorage key */
export const AUTH_TOKEN_STORAGE_KEY = 'aicorrection_auth_token';

/**
 * 仅供「上传原图回显」使用的 HttpOnly cookie 名（真实账号路径）。
 * 与 LICENSE_COOKIE_NAME 对称：<img src="/api/v1/uploads/..."> 由浏览器直连，无法带自定义 header；
 * 登录成功后由服务端下发此 cookie，requireLicense 仅在 /uploads/* 接受它，避免变成全站 CSRF 凭证。
 */
export const AUTH_COOKIE_NAME = 'aicorrection_auth';

/** 真实账号登录方式（与 accounts 表 provider CHECK 约束一致） */
export const AUTH_PROVIDERS = ['password', 'sms', 'wechat', 'magic'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

/** 密码最小长度（弱密码直接拒绝，不让落地） */
export const AUTH_PASSWORD_MIN_LEN = 8;

/** SMS 验证码长度 */
export const SMS_CODE_LEN = 6;

/** dev 模式标记：未配置真实 SMS/Email/WeChat provider 时，验证码/魔法链接直接回显给调用方 */
export const AUTH_DEV_MODE = !process.env.SMS_PROVIDER && !process.env.EMAIL_PROVIDER;

// ===================== 商业化：卡密即权益层 =====================

/** 订阅档位（卡密携带的权益等级）。free 为默认档。 */
export const LICENSE_TIERS = ['free', 'pro', 'max'] as const;
export type LicenseTier = (typeof LICENSE_TIERS)[number];

/** 档位展示名（前端直接展示，避免散落中文串） */
export const LICENSE_TIER_LABELS: Record<LicenseTier, string> = {
  free: '免费版',
  pro: '专业版',
  max: '旗舰版',
};

/**
 * 权益点（功能开关）。核心闭环 core_loop 始终包含；
 * 进阶能力按档位逐级解锁，前端据此显隐「升级」入口、后端据此做接口级闸门。
 */
export const ENTITLEMENTS = [
  'core_loop',        // 基础五步闭环（上传→归因→判分→复述→追问）
  'unlimited_loops',  // 无限次闭环（免费版每日有限额 FREE_DAILY_LOOP_QUOTA）
  'spaced_review',    // 间隔复习（R15/R16）
  'custom_kp',        // 自定义知识点（R17）
  'knowledge_graph',  // 知识图谱（R18）
  'advanced_models',  // 高级解析模型
  'priority_support', // 优先支持
] as const;
export type Entitlement = (typeof ENTITLEMENTS)[number];

/** 各档位权益集合（冻结映射，与发卡时写入 license_keys.entitlements_json 一致） */
export const TIER_ENTITLEMENTS: Record<LicenseTier, Entitlement[]> = {
  free: ['core_loop'],
  pro: ['core_loop', 'unlimited_loops', 'spaced_review', 'custom_kp', 'knowledge_graph'],
  max: [
    'core_loop',
    'unlimited_loops',
    'spaced_review',
    'custom_kp',
    'knowledge_graph',
    'advanced_models',
    'priority_support',
  ],
};

/** 各档位默认有效期（天），用于发卡/续费默认时长 */
export const TIER_DEFAULT_DURATION_DAYS: Record<LicenseTier, number> = {
  free: 30,
  pro: 365,
  max: 365,
};

/** 免费版每日闭环配额（非 unlimited_loops 档时生效） */
export const FREE_DAILY_LOOP_QUOTA = 5;

/** 支付 provider 未配置时的错误码（与 AUTH_PROVIDER_NOT_CONFIGURED 对称） */
export const PAYMENT_PROVIDER_ENV = 'PAYMENT_PROVIDER';

// ===================== 质量优化：G1 闸门 / B·C·D 分层 / 代理↔质量校准 =====================

/**
 * G1 质量闸门阈值（冻结）。
 * 每项检查带 severity：blocker 不达标则整体不通过（不可发布）；warning 仅提示。
 * 阈值设定依据：approval_rate 复用 M1 闸门 0.70；三件套完整率与闭环完成率为产品健康底线；
 * 盲评覆盖率确保正式盲评（QAL-01）有足够样本支撑质量结论。
 */
export const G1_GATE_THRESHOLDS = {
  approval_rate: { comparator: 'min' as const, threshold: 0.7, severity: 'blocker' as const, label: '归因认可率' },
  three_item_rate: { comparator: 'min' as const, threshold: 0.8, severity: 'warning' as const, label: '三件套完整率' },
  upload_fail_rate: { comparator: 'max' as const, threshold: 0.05, severity: 'warning' as const, label: '上传失败率' },
  completion_rate: { comparator: 'min' as const, threshold: 0.5, severity: 'warning' as const, label: '闭环完成率' },
  review_coverage: { comparator: 'min' as const, threshold: 0.3, severity: 'warning' as const, label: '盲评覆盖率' },
} as const;

/** 质量分层（B·C·D 评估集）：A 通用 / B 边界 / C 极端罕见 / D 干扰陷阱。 */
export const QUALITY_STRATA = ['A', 'B', 'C', 'D'] as const;
export type QualityStratum = (typeof QUALITY_STRATA)[number];

/** 分层标签（前端展示）。 */
export const STRATUM_LABELS: Record<QualityStratum, string> = {
  A: '通用题',
  B: '边界题',
  C: '极端/罕见题',
  D: '干扰/陷阱题',
};

/** 校准先验：代理无置信度时回落到 0.5（不乐观、不悲观）。 */
export const CALIBRATION_PRIOR = 0.5;

/** 触发 D 层（干扰陷阱）的「常见误解」错因；触发 C 层（极端罕见）的「罕见错因」。 */
export const MISCONCEPTION_CAUSES = ['concept_confusion', 'method_error'] as const;
export const RARE_CAUSES = ['memory_gap', 'reading_error'] as const;

// ===================== P1 强化期（R09 错因聚合 / R14 掌握判定） =====================

/**
 * 错因受控词表（与 attributions.cause_id CHECK 约束完全一致）。
 * 冻结分类：概念混淆 / 方法错误 / 计算失误 / 审题不清 / 记忆缺漏 / 其他。
 * 前端聚合与展示一律走这里的标签，避免散落中文串。
 */
export const CAUSE_TAXONOMY = {
  concept_confusion: '概念混淆',
  method_error: '方法错误',
  calculation_error: '计算失误',
  reading_error: '审题不清',
  memory_gap: '记忆缺漏',
  other: '其他',
} as const;
export type CauseId = keyof typeof CAUSE_TAXONOMY;

/** 掌握等级状态机（R14，受 mastery_state.level CHECK 约束） */
export const MASTERY_LEVELS = [
  'not_started',
  'learning',
  'familiar',
  'mastered',
] as const;
export type MasteryLevel = (typeof MASTERY_LEVELS)[number];

/** 掌握等级展示标签 */
export const MASTERY_LABELS: Record<MasteryLevel, string> = {
  not_started: '未开始',
  learning: '学习中',
  familiar: '较熟悉',
  mastered: '已掌握',
};

/**
 * kp_key 归一规则：优先受控词表 knowledge_point_id（kp_xxx）；
 * 旧归因缺失 id 时退化为 'txt:<knowledge_point 文本>'，保证跨来源同一知识点可追溯。
 */
export function normalizeKpKey(
  knowledgePointId: string | null,
  knowledgePoint: string | null
): string {
  if (knowledgePointId && knowledgePointId.trim()) return knowledgePointId.trim();
  const txt = (knowledgePoint || '').trim();
  return txt ? `txt:${txt}` : 'txt:（未标注知识点）';
}
