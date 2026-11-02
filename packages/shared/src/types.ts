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
} from './constants';

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
