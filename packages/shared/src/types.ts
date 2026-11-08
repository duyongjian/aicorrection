/**
 * 实体类型 + API 请求/响应类型（前后端共用）
 * 对齐：架构设计文档 §3.1 SQL Schema / §3.2 REST 契约
 */
import type {
  Segment,
  ExpGroup,
  SrcType,
  OcrStatus,
  RateAction,
  InaccurateReason,
  AuthProvider,
  MasteryLevel,
  CauseId,
  LicenseTier,
  Entitlement,
  QualityStratum,
} from './constants';

// ===================== 灰度/金丝雀发布（K1.4） =====================

/** 灰度分组：control（对照）/ treatment（实验）。两值受 attributions / analytics_events 的 CHECK 约束。 */
export type RolloutGroup = 'control' | 'treatment';

// ===================== 实体类型 =====================

export interface User {
  anon_user_id: string;
  segment: Segment;
  exp_id: string | null;
  exp_group: ExpGroup;
  register_ts: string;
  first_pay_ts: string | null;
  last_active_ts: string | null;
  churn_status: 'active' | 'sub_expired' | 'inactive';
  churn_ts: string | null;
  created_at: string;
}

export interface Mistake {
  mistake_id: string;
  anon_user_id: string;
  loop_id: string;
  subject: string | null;
  src_type: SrcType;
  ocr_status: OcrStatus;
  mistake_ref: string | null;
  created_at: string;
}

export interface Attribution {
  attribution_id: string;
  loop_id: string;
  anon_user_id: string;
  mistake_id: string | null;
  /** K1.3: 题干快照（用于盲评回放，一条归因即一条可复盘样本） */
  question: string | null;
  /** K1.3: 用户作答快照；无作答（讲解模式）时为 null */
  user_answer: string | null;
  cause: string | null;
  knowledge_point: string | null;
  essence: string | null;
  /** ATT-01b: 无作答讲解模式——正确答案 */
  correct_answer: string | null;
  /** ATT-01b: 无作答讲解模式——正确推导 */
  derivation: string | null;
  /** ATT-01b: 无作答讲解模式——本题常见陷阱 */
  pitfalls: string | null;
  attr_model_version: string | null;
  attr_latency_ms: number | null;
  rate_action: RateAction | null;
  inaccurate_reason: InaccurateReason | null;
  expert_consistency: 'agree' | 'disagree' | null;
  expert_accuracy: 'accurate' | 'inaccurate' | null;
  /** J8: 结构化知识点对应 ID（受控词表 kp_*） */
  knowledge_point_id: string | null;
  /** J8: 结构化归因类型（受控词表 cause_*） */
  cause_id: string | null;
  /** J8: 知识点分类法版本 */
  kq_taxonomy_version: string;
  /** J8: 归因分类法版本 */
  cause_taxonomy_version: string;
  /** T4: 是否使用 mock provider 生成 */
  is_mock: number;
  /** T4: 是否内部账号 */
  is_internal: number;
  /** K1.4: 灰度分组 control/treatment（按 cohort 落库，支撑 treatment vs control 指标对比） */
  rollout_group: RolloutGroup;
  created_at: string;
}

/**
 * 归因历史列表项（FLW-02）：按用户聚合 attributions + 关联 mistakes 的展示字段。
 * 前端历史页据此渲染每条往期归因的缩略图、学科、时间与三要素结论。
 */
export interface HistoryItem {
  attribution_id: string;
  loop_id: string;
  anon_user_id: string;
  cause: string | null;
  knowledge_point: string | null;
  essence: string | null;
  /** ATT-01b: 无作答讲解模式教学字段（仅该模式填充，缺省 null） */
  correct_answer: string | null;
  derivation: string | null;
  pitfalls: string | null;
  attr_model_version: string | null;
  attr_latency_ms: number | null;
  /** 用户认可动作：approve / inaccurate / report / null（未评价） */
  rate_action: RateAction | null;
  created_at: string;
  // ── 以下由 mistakes 关联得到 ──
  subject: string | null;
  src_type: SrcType | null;
  /** 图片入口拼接好的可访问原图 URL（文本入口为 null） */
  image_url: string | null;
}

export interface HistoryResponse extends ApiResponse<HistoryItem[]> {}

export interface LoopSession {
  loop_id: string;
  anon_user_id: string;
  segment: Segment | null;
  session_id: string | null;
  start_ts: string;
  complete_ts: string | null;
  duration_ms: number | null;
  loop_complete: 0 | 1;
  verify_result: 'pass' | 'fail' | 'give_up' | null;
  verify_rounds: number | null;
  followup_rounds: number;
  has_practice: 0 | 1 | null;
  restate_len: number | null;
  restate_is_copy: 0 | 1 | null;
  /** v0.2 R05 复盘本质完整文本 */
  restate_text?: string | null;
  /** v0.2 R06 追问验证：探针问题 / 用户应答 / 反馈 */
  verify_prompt?: string | null;
  verify_response?: string | null;
  verify_feedback?: string | null;
  created_at: string;
}

export interface AnalyticsEvent {
  event_id: string;
  event_name: string;
  anon_user_id: string | null;
  loop_id: string | null;
  session_id: string | null;
  context_json: string;
  props_json: string;
  ts_utc: string;
  idempotency_key: string | null;
  received_at: string;
  /** T4: 是否使用 mock provider 生成 */
  is_mock: number;
  /** T4: 是否内部账号 */
  is_internal: number;
  /** K1.4: 灰度分组 control/treatment（支撑按 cohort 的曝光/漏斗/指标分析） */
  rollout_group: RolloutGroup;
}

// ===================== 统一响应信封 =====================

export interface ApiResponse<T> {
  code: number;
  data: T;
  message: string;
}

/** 错误码约定（§7.6） */
export const ERROR_CODES = {
  SUCCESS: 0,
  PARAM_INVALID: 1001,
  NOT_FOUND: 2001,
  ATTR_TIMEOUT: 3002,
  ATTR_INCOMPLETE: 3003,
  FOLLOWUP_LIMIT: 3004,
  // 卡密门禁（线下分发 MVP）：4xxx 段，均为可展示给用户的明确原因
  LICENSE_REQUIRED: 4001,
  LICENSE_INVALID: 4002,
  LICENSE_ALREADY_USED: 4003,
  LICENSE_REVOKED: 4004,
  LICENSE_EXPIRED: 4005,
  /** 凭证有效但缺少某付费权益（按档位功能限制）；HTTP 403。 */
  ENTITLEMENT_REQUIRED: 4006,
  // 真实账号体系（v0.2）：5xxx 段，均为可展示给用户的明确原因
  AUTH_REQUIRED: 5001,
  AUTH_INVALID: 5002,
  AUTH_EMAIL_TAKEN: 5003,
  AUTH_CODE_EXPIRED: 5004,
  AUTH_CODE_INVALID: 5005,
  AUTH_PROVIDER_NOT_CONFIGURED: 5006,
  AUTH_TOO_MANY_ATTEMPTS: 5007,
  AUTH_PASSWORD_WEAK: 5008,
  AUTH_PHONE_TAKEN: 5009,
  // 商业化（订阅/支付）：6xxx 段
  PAYMENT_PROVIDER_NOT_CONFIGURED: 6001,
  SUBSCRIPTION_NOT_FOUND: 6002,
  LICENSE_NOT_FOUND: 6003,
  INTERNAL: 5000,
} as const;

// ===================== 账户 (INF-01) =====================

export interface CreateAccountRequest {
  segment: Segment;
  client_hint?: string;
}

export interface AccountResponse {
  anon_user_id: string;
  segment: Segment;
  exp_id: string | null;
  exp_group: ExpGroup;
  register_ts: string;
}

export interface GetAccountResponse extends AccountResponse {}

// ===================== 上传 (R01 / UPL-02) =====================

export interface UploadRequest {
  anon_user_id: string;
  segment: Segment;
  session_id: string;
  src_type: SrcType;
  subject?: string;
  retry_count: number;
  photo_blur: boolean;
  upload_duration_ms: number;
  raw_text?: string;
  context?: unknown;
}

/** 前端 multipart 字段（image 文件 + 其余字段），与 JSON 入口共用 UploadRequest 语义 */
export interface UploadResponse {
  loop_id: string;
  mistake_id: string;
  ocr_status: OcrStatus;
  question: string;
  /** 公式识别得到的 LaTeX；非公式/未启用公式识别时为 null。可选以保证旧消费方兼容。 */
  latex?: string | null;
  /** 原图可访问 URL（相对路径，如 /api/v1/uploads/m_xxx.jpg）；文本/粘贴入口为 null。 */
  image_url?: string | null;
}

// ===================== 归因 (R02 / ATT-02) =====================

export interface AttributionRequest {
  loop_id: string;
  anon_user_id: string;
  question: string;
  user_answer?: string;
  context?: unknown;
}

export interface AttributionOkData {
  status: 'ok';
  attribution_id: string;
  loop_id: string;
  cause: string;
  knowledge_point: string;
  essence: string;
  attr_model_version: string;
  attr_latency_ms: number;
  complete: true;
  /** ATT-01b: 无作答讲解模式教学字段（仅该模式填充，诊断模式为 undefined） */
  correct_answer?: string;
  derivation?: string;
  pitfalls?: string;
  /** P1: 题库 RAG 参考块。命中相似题时带回（source='qbank'），供前端展示"诊断依据"；
   *  未命中 / 关闭 / 检索失败时为 undefined。绝不虚构内容。 */
  references?: AttributionReference;
  /** P2: 联网搜索参考块（默认关闭）。开启且命中时带回（source='web'），供前端展示"网络依据"；
   *  关闭 / 失败 / 未命中时为 undefined。绝不虚构内容。 */
  webSearch?: AttributionWebSearch;
}

export interface AttributionDegradedData {
  status: 'analyzing' | 'incomplete';
}

export type AttributionData = AttributionOkData | AttributionDegradedData;

// ===================== 题库 RAG 参考块 (P1) =====================

/** 单条参考项（来自题库 qbank_items）。 */
export interface AttributionReferenceItem {
  /** 题库项 ID */
  item_id: string;
  /** 展示标题：等于 knowledge_point 文本 */
  title: string;
  /** 参考片段（answer_text 截断，约 240 字），仅供对照，非本题答案 */
  snippet: string;
  /** 结构化知识点文本（与 title 同源，便于前端按知识点聚合） */
  knowledge_point: string;
  /** 余弦相似度（已四舍五入至 4 位） */
  score: number;
}

/**
 * 题库 RAG 检索结果信封。
 * status:
 *  - 'ok'        命中且高于阈值，items 非空；
 *  - 'empty'     已检索但无高于阈值项（或库为空），items=[]；
 *  - 'unavailable' 检索异常（嵌入/DB 失败）→ 仅跳过参考块，归因照常进行，绝不抛错/虚构。
 * source 固定 'qbank'（预留扩展：未来可接外部知识库）。
 */
export interface AttributionReference {
  status: 'ok' | 'empty' | 'unavailable';
  source: 'qbank';
  items: AttributionReferenceItem[];
}

// ===================== 联网搜索参考块 (P2) =====================

/** 单条网络检索结果（来自搜索引擎）。 */
export interface AttributionWebSearchItem {
  /** 结果标题 */
  title: string;
  /** 来源链接 */
  url: string;
  /** 摘要片段（截断，约 200 字），仅供对照，非本题答案 */
  snippet: string;
  /** 相似度/相关性占位（搜索引擎无余弦分，置 1 或省略） */
  score?: number;
}

/**
 * 联网搜索检索结果信封（P2）。
 * 与题库 RAG 同契约：
 *  - 'ok'        检索成功且命中，items 非空；
 *  - 'empty'     已检索但无结果（或功能关闭/未配置），items=[]；
 *  - 'unavailable' 检索异常（网络/解析失败/超时）→ 仅跳过，归因照常，绝不抛错/虚构。
 * source 固定 'web'（预留扩展：未来可接多个搜索引擎聚合）。
 */
export interface AttributionWebSearch {
  status: 'ok' | 'empty' | 'unavailable';
  source: 'web';
  items: AttributionWebSearchItem[];
}

// ===================== 认可/评分 (R03 / ATT-04) =====================

export interface RateRequest {
  anon_user_id: string;
  rate_action: RateAction;
  rate_score?: number;
  inaccurate_reason?: InaccurateReason;
  inaccurate_text?: string;
  context?: unknown;
}

export interface RateResponse {
  ok: true;
  rate_action: RateAction;
}

// ===================== 追问 (R03 / FLW-01) =====================

export interface FollowupRequest {
  anon_user_id: string;
  message: string;
  followup_round: number;
  context?: unknown;
}

export interface FollowupResponse {
  followup_round: number;
  role: 'ai_ask' | 'ai_answer';
  content: string;
  has_next_action: boolean;
  followup_rounds_remaining: number;
}

// ===================== 专家盲评 (QAL-01) =====================

export interface ReviewWriteRequest {
  expert_id: string;
  expert_accuracy: 'accurate' | 'inaccurate';
  expert_consistency?: 'agree' | 'disagree';
  note?: string;
}

export interface ReviewPendingItem {
  attribution_id: string;
  loop_id: string;
  cause: string;
  knowledge_point: string;
  essence: string;
  attr_model_version: string;
}

export interface ReviewPendingResponse {
  items: ReviewPendingItem[];
}

export interface ReviewWriteResponse {
  ok: true;
}

// ===================== 埋点 (INF-03) =====================

import type { TrackEvent } from './events';

export interface TrackIngestRequest {
  events: TrackEvent[];
}

export interface TrackIngestResponse {
  accepted: number;
  rejected: number;
  dup: number;
}

// ===================== 看板 (QAL-02) =====================

export interface M1Stats {
  approval_rate: number;
  three_item_rate: number;
  upload_to_attr_latency_ms: {
    p50: number;
    p95: number;
  };
  upload_fail_rate: number;
  window: string;
  gate: 'go' | 'no-go';
}

export interface DashboardM1Response extends M1Stats {}

// ===================== 上传失败细分（v0.1.x 诊断口径） =====================

export interface UploadFailureBucket {
  key: string;
  count: number;
}

// ===================== 卡密 / 线下分发 MVP =====================

/**
 * 线下内测分发凭证。设计取舍：卡密即账号 —— 不引入手机号/邮箱/微信注册，
 * 避免外发与注册摩擦；兑换成功即创建既有 `anon_user_id`，主流程零改动。
 * 服务端只存卡密与 token 的 SHA-256，明文仅在管理员本机生成时输出一次。
 */

/** 兑换请求：卡密 + 用户分段（分段沿用既有 SEGMENTS） */
export interface LicenseRedeemRequest {
  code: string;
  segment: Segment;
}

/** 兑换成功响应：license_token 是后续所有业务请求的凭证 */
export interface LicenseRedeemResponse {
  license_token: string;
  anon_user_id: string;
  segment: Segment;
  batch_id: string | null;
  tier: LicenseTier;
  entitlements: Entitlement[];
  expires_at: string | null;
  bound_at: string;
}

/**
 * 凭证状态：前端每次冷启动校验一次，失效即回到激活页。
 * `gate_enabled=false` 表示服务端未开启卡密门禁（开发/未分发模式），
 * 此时前端必须直接放行，不能显示一张永远无法通过的激活页。
 */
export interface LicenseStatusResponse {
  active: boolean;
  /** 服务端是否开启卡密门禁；前端据此区分「未激活」与「本就无需激活」 */
  gate_enabled: boolean;
  anon_user_id: string | null;
  segment: Segment | null;
  batch_id: string | null;
  tier: LicenseTier | null;
  entitlements: Entitlement[];
  expires_at: string | null;
  is_expired: boolean;
  reason?: 'missing' | 'invalid' | 'revoked' | 'expired';
}

/** 卡密状态枚举（管理端 CLI 与 DB CHECK 约束一致） */
export const LICENSE_STATUSES = ['unused', 'redeemed', 'revoked'] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

// ===================== 商业化：卡密即权益层 =====================

/** 当前档位与权益快照（前端显隐功能入口、后端接口级闸门共用） */
export interface LicensePlanResponse {
  tier: LicenseTier;
  tier_label: string;
  entitlements: Entitlement[];
  expires_at: string | null;
  is_expired: boolean;
  /** 无卡密/未激活用户（如仅用真实账号登录者）默认免费档，可走升档流程 */
  can_renew: boolean;
}

/** 续费请求：线下场景靠 license_token 或 code 定位卡密并延长有效期 */
export interface LicenseRenewRequest {
  license_token?: string;
  code?: string;
  /** 延长天数；不传则按当前档位默认时长（TIER_DEFAULT_DURATION_DAYS） */
  days?: number;
  /** 续费后是否升档；不传则保持原档位 */
  tier?: LicenseTier;
}

export interface LicenseRenewResponse {
  ok: boolean;
  tier: LicenseTier;
  expires_at: string | null;
  message: string;
}

/** 发起订阅/支付（线上支付 provider 未配置时返回 PAYMENT_PROVIDER_NOT_CONFIGURED） */
export interface CreateSubscriptionRequest {
  anon_user_id: string;
  tier: LicenseTier;
  provider?: 'stripe' | 'wechat_pay' | 'none';
  return_url?: string;
}

export interface CreateSubscriptionResponse {
  ok: boolean;
  provider: 'stripe' | 'wechat_pay' | 'none';
  subscription_id?: string;
  checkout_url?: string;
  message: string;
}

/** 订阅视图（管理端/前端「我的订阅」） */
export interface SubscriptionView {
  subscription_id: string;
  tier: LicenseTier;
  status: 'active' | 'cancelled' | 'expired';
  provider: string;
  current_period_start: string;
  current_period_end: string;
}

/** 支付台账视图 */
export interface PaymentView {
  payment_id: string;
  provider: string;
  amount_cents: number;
  currency: string;
  tier: LicenseTier;
  status: 'pending' | 'paid' | 'failed';
  created_at: string;
  paid_at: string | null;
}

/**
 * 尝试级上传失败诊断。与 G1/M5 的关系：
 *  - `m5` 段逐字复现 M5 正式口径（分母 loop_upload 总数、分子 ocr_status='fail'），**不得改写**；
 *  - `attempt_*` 是新增诊断口径，把传输/服务端/校验失败纳入分母与分子，通常会比 M5 更高；
 *  - 两者必须同时上报，禁止用 attempt_* 替换 M5 去「让指标好看或难看」。
 */
export interface UploadFailureBreakdown {
  window: string;
  /** 统计范围说明，固定为真实流量过滤条件 */
  scope: string;
  /** 尝试总数 = loop_upload 总数 + upload_fail 总数 */
  attempt_total: number;
  /** 失败总数 = ocr_fail + upload_fail 总数（两类事件互斥） */
  failure_total: number;
  attempt_failure_rate: number;
  /** G1/M5 原口径，保持不变 */
  m5: {
    loop_upload_total: number;
    ocr_fail: number;
    upload_fail_rate: number;
  };
  /** stage='ocr' 由 loop_upload.ocr_status='fail' 合成，其余来自 upload_fail */
  by_stage: UploadFailureBucket[];
  by_reason: UploadFailureBucket[];
  by_stage_reason: UploadFailureBucket[];
}

// ===================== 质量优化：G1 闸门 / B·C·D 分层 / 校准 =====================

/** 单条质量检查结果 */
export interface QualityCheck {
  name: string;
  label: string;
  value: number;
  /** 阈值含义：min=值需≥阈值；max=值需≤阈值 */
  comparator: 'min' | 'max';
  threshold: number;
  pass: boolean;
  severity: 'blocker' | 'warning';
  detail: string;
}

/** G1 质量闸门聚合报告 */
export interface QualityScorecard {
  passed: boolean;
  /** 综合分 0–1：blocker 权重 2、warning 权重 1 */
  score: number;
  readiness: 'ship' | 'hold';
  checks: QualityCheck[];
  blockers: string[];
  warnings: string[];
  generated_at: string;
  window: string;
}

/** 单知识点分层统计 */
export interface StratumReport {
  stratum: QualityStratum;
  label: string;
  kp_count: number;
  reviewed_count: number;
  /** 该层盲评覆盖率 0–1 */
  coverage: number;
}

export interface StrataReportResponse {
  items: StratumReport[];
  total_kp: number;
}

/** 代理↔质量校准请求/响应 */
export interface CalibrationRequest {
  /** 代理自报质量分 0–1 */
  raw_score: number;
  /** 代理置信度 0–1 */
  confidence: number;
}
export interface CalibrationResponse {
  raw_score: number;
  confidence: number;
  prior: number;
  /** 校准后质量分（单调、保守，不会超过 raw_score） */
  calibrated: number;
}

// ===================== 真实账号体系 (auth) =====================
//
// 凭证层挂在既有 anon_user_id 之上：任一登录方式最终都解析回同一个 anon_user_id，
// 因此错题/归因/闭环/埋点数据天然归属同一用户，老匿名与卡密身份不丢。

/** 登录/注册成功统一响应：auth_token 是后续所有业务请求的凭证（对称于 license_token）。 */
export interface AuthTokenResponse {
  auth_token: string;
  anon_user_id: string;
  segment: Segment;
  provider: AuthProvider;
  bound_at: string;
}

/** 邮箱密码注册 */
export interface AuthRegisterRequest {
  email: string;
  password: string;
  segment: Segment;
  /**
   * 可选：绑定到已有 anon_user_id（如卡密/匿名用户后来补绑邮箱）。
   * 提供且有效时，新凭证挂到该身份而非新建账号；不提供则新建。
   */
  link_anon_user_id?: string;
}

/** 邮箱密码登录 */
export interface AuthLoginRequest {
  email: string;
  password: string;
  /**
   * 可选：登录时把浏览器本地匿名身份（anon_user_id）下的错题/归因等记录迁移到本账号。
   * 提供且有效、且与账号现有 anon_user_id 不同时触发合并；否则忽略。
   */
  link_anon_user_id?: string;
}

/** 发送短信验证码（dev 模式会在响应里回显 dev_code） */
export interface AuthSmsSendRequest {
  phone: string;
}
export interface AuthSmsSendResponse {
  ok: true;
  /** 仅 dev 模式（未配置 SMS_PROVIDER）返回，便于离线自测 */
  dev_code?: string;
  message: string;
}

/** 短信验证码登录/注册 */
export interface AuthSmsVerifyRequest {
  phone: string;
  code: string;
  segment: Segment;
  /** 可选：绑定到已有 anon_user_id（卡密/匿名用户补绑手机） */
  link_anon_user_id?: string;
}

/** 微信 OAuth code 换登录态 */
export interface AuthWechatRequest {
  code: string;
  /** 可选：绑定到已有 anon_user_id */
  link_anon_user_id?: string;
}

/** 发送魔法链接（dev 模式会在响应里回显 dev_token） */
export interface AuthMagicSendRequest {
  email: string;
}
export interface AuthMagicSendResponse {
  ok: true;
  /** 仅 dev 模式（未配置 EMAIL_PROVIDER）返回，便于离线自测 */
  dev_token?: string;
  message: string;
}

/** 魔法链接登录/注册 */
export interface AuthMagicVerifyRequest {
  token: string;
  segment?: Segment;
  /** 可选：绑定到已有 anon_user_id */
  link_anon_user_id?: string;
}

/** 当前登录态（用于前端冷启动校验，对称于 LicenseStatusResponse） */
export interface AuthStatusResponse {
  active: boolean;
  anon_user_id: string | null;
  segment: Segment | null;
  provider: AuthProvider | null;
  /** 同一 anon_user_id 已绑定的所有登录方式（用于「账号设置」展示） */
  providers: AuthProvider[];
  /** 主登录标识（邮箱/手机号等，用于「账号设置」展示；匿名态为 null） */
  identifier?: string | null;
}

/** 当前账号信息 */
export interface AuthMeResponse {
  anon_user_id: string | null;
  segment: Segment | null;
  providers: AuthProvider[];
  /** 主登录标识（邮箱/手机号等；匿名态为 null） */
  identifier?: string | null;
}

// ===================== P1 强化期（R09 错因聚合 / R10 薄弱点 / R14 掌握判定 / R11 沉淀 / R13 针对性题组） =====================

/** R09 单条错因聚合（含中文标签与占比） */
export interface CauseAggregationItem {
  cause_id: CauseId;
  cause_label: string;
  count: number;
  /** 占比 0–1（相对该用户总错因数） */
  pct: number;
}

/** R09 错因聚合响应（按 count 降序） */
export interface CauseAggregationResponse {
  anon_user_id: string;
  total: number;
  items: CauseAggregationItem[];
}

/** R10 单条薄弱点（按知识点聚合：错误数 + 练习数 + 掌握等级 + 主要错因） */
export interface WeakPointItem {
  /** 知识点归一键（kp_id 或 txt:<文本>） */
  kp_key: string;
  /** 知识点展示文本 */
  kp_text: string;
  /** 该知识点下归因错误数（attributions 计数） */
  error_count: number;
  /** 该知识点下练习作答数（practice_items 计数） */
  practice_count: number;
  /** 掌握等级（R14） */
  mastery_level: MasteryLevel;
  /** 主要错因（错误数最高的 cause_id） */
  top_cause: CauseId | null;
  top_cause_label: string | null;
}

/** R10 薄弱点可视化响应（按 error_count 降序；并列按 mastery 升序） */
export interface WeakPointsResponse {
  anon_user_id: string;
  items: WeakPointItem[];
}

/** R14 掌握状态（单个知识点） */
export interface MasteryState {
  anon_user_id: string;
  kp_key: string;
  kp_text: string;
  level: MasteryLevel;
  /** 累计练习次数 */
  attempts: number;
  /** 累计答对次数 */
  correct: number;
  /** 当前连续答对次数（用于升级判定，错一次清零） */
  correct_streak: number;
  last_practiced_ts: string | null;
  updated_at: string;
}

export interface MasteryListResponse {
  anon_user_id: string;
  items: MasteryState[];
}

/** R11 答案沉淀请求：把用户/老师认可的题目+解析沉淀进题库（UGC）。 */
export interface SedimentRequest {
  anon_user_id: string;
  /** 可选：来源闭环（用于合规留痕，可空） */
  loop_id?: string | null;
  question: string;
  answer: string;
  /** 可选：知识点文本（缺省为空串，由 qbank 归类为 other/无知识点） */
  knowledge_point?: string | null;
  /** 可选：原始题干片段（来源合规留痕） */
  snippet?: string | null;
  /** 可选学科 slug（math/english/politics/logic/other）；缺省 other */
  subject?: string | null;
}

export interface SedimentResponse {
  item_id: string;
  /** UGC 入库状态：pending（待审） */
  status: 'pending';
  message: string;
}

/**
 * R13 针对性多题练习请求：针对某个薄弱知识点生成一组练习题。
 * target_kp 为知识点文本（与 qbank/knowledge_point 对齐，用于题库检索）；
 * kp_key 为掌握度键（缺省由 target_kp 推导为 'txt:<文本>'）。前端传薄弱点的 kp_key 可保证
 * 练习作答回写到同一掌握度记录（与 R10/R14 对齐）。
 */
export interface GenerateGroupRequest {
  anon_user_id: string;
  target_kp: string;
  count: number;
  kp_key?: string | null;
}

/** R13 题组中单题（不下发答案，由 grade 阶段内部比对） */
export interface GenerateGroupItem {
  practice_id: string;
  loop_id: string | null;
  question_text: string;
  source: 'qbank' | 'llm';
  kp_id: string | null;
  group_seq: number;
}

export interface GenerateGroupResponse {
  group_id: string;
  target_kp: string;
  items: GenerateGroupItem[];
}

// ===================== P2 规模化期（R15 间隔复习 / R16 复习列表 / R12 变式题 / R17 自定义知识点 / R20 手动错因 / R18 知识图谱） =====================

/** R15/R16 复习计划（每个用户-知识点一条）。 */
export interface ReviewScheduleItem {
  anon_user_id: string;
  kp_key: string;
  kp_text: string | null;
  interval_days: number;
  ease: number;
  last_result: 'correct' | 'wrong' | 'skip' | null;
  next_review_ts: string | null;
  /** 是否已到期（next_review_ts <= now 或尚未排程），由 R16 列表接口填充。 */
  is_due?: boolean;
}

export interface DueReviewResponse {
  anon_user_id: string;
  items: ReviewScheduleItem[];
}

/** R12/R15：发起一次复测（返回变式题，避免"原题测记忆"）。 */
export interface StartReviewResponse {
  review_id: string;
  kp_key: string;
  kp_text: string | null;
  question_text: string;
  is_variant: 1 | 0;
  source: 'variant' | 'generic';
}

export interface CompleteReviewResponse {
  review_id: string;
  retest_result: 'correct' | 'wrong' | 'skip';
  next_review_ts: string | null;
  interval_days: number;
}

/** R17 自定义知识点。 */
export interface CustomKpItem {
  kp_id: string;
  anon_user_id: string;
  kp_text: string;
  parent_kp_key: string | null;
  created_at: string;
}

export interface CustomKpListResponse {
  anon_user_id: string;
  items: CustomKpItem[];
}

export interface CreateCustomKpRequest {
  anon_user_id: string;
  kp_text: string;
  parent_kp_key?: string | null;
}

export interface CreateCustomKpResponse {
  kp_id: string;
  kp_text: string;
  parent_kp_key: string | null;
}

/** R20 手动错因标记：用户覆盖 AI 的 cause / knowledge_point。 */
export interface ManualCauseRequest {
  loop_id: string;
  anon_user_id: string;
  cause_id?: string | null;
  knowledge_point?: string | null;
  knowledge_point_id?: string | null;
}

export interface ManualCauseResponse {
  loop_id: string;
  cause_id: string | null;
  knowledge_point: string | null;
  knowledge_point_id: string | null;
}

/** R18 知识图谱：kp 节点 + 共现边。 */
export interface KnowledgeGraphNode {
  kp_key: string;
  kp_text: string;
  error_count: number;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface KnowledgeGraphResponse {
  anon_user_id: string;
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}
