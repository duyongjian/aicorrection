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
}

export interface AttributionDegradedData {
  status: 'analyzing' | 'incomplete';
}

export type AttributionData = AttributionOkData | AttributionDegradedData;

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
