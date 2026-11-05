/**
 * 上传失败细分埋点（v0.1.x 增量）——受控词表 + 纯分类函数。
 *
 * 背景：v0.1 的 M5「上传失败率」唯一信号是 `loop_upload.props.ocr_status='fail'`，
 * 只在**服务端返回 200 且已创建 loop** 时才上报。于是：
 *   - 传输/网络失败、HTTP 4xx/5xx、业务错误码、前端校验失败 → 完全没有埋点；
 *   - 「识别失败」与「请求根本没到后端」混在一起，无法定位。
 *
 * 本模块只提供**纯函数与受控词表**，不含 I/O，便于前后端共用 + 单测。
 *
 * 口径纪律（见 docs/上传失败细分埋点.md）：
 *   - `loop_upload`（含 ocr_status='fail'）**仍是 G1/M5 的唯一正式数据源**，本模块不改变它；
 *   - `upload_fail` 只覆盖「未拿到 200 + loop 的失败」，与 OCR 失败**互斥、不重叠**；
 *   - 尝试级失败率 = (ocr_fail + upload_fail) / (loop_upload + upload_fail)，
 *     是**新增诊断口径**，不得替换 G1 的 M5 口径。
 */

/** 失败阶段：定位「在哪一层失败」。`ocr` 由 loop_upload 承载，upload_fail 不产出该值。 */
export const UPLOAD_FAILURE_STAGES = [
  'client_validation',
  'account_create',
  'transport',
  'server_reject',
  'business_error',
  'ocr',
  'unknown',
] as const;
export type UploadFailureStage = (typeof UPLOAD_FAILURE_STAGES)[number];

/** 失败原因：定位「为什么失败」。只允许枚举值，禁止把原始错误文案/学生内容写进埋点。 */
export const UPLOAD_FAILURE_REASONS = [
  'missing_image',
  'missing_text',
  'network_error',
  'timeout',
  'http_4xx',
  'http_5xx',
  'http_other',
  'backend_reject',
  'ocr_fail',
  'unknown',
] as const;
export type UploadFailureReason = (typeof UPLOAD_FAILURE_REASONS)[number];

/** 一次上传尝试里，请求所处的阶段（由调用方传入，用于区分建账户失败与上传失败）。 */
export type UploadRequestPhase = 'account_create' | 'upload';

/**
 * axios 错误的**结构化信号**。刻意不携带自由文本：
 * `message` 只用于判定超时/网络关键词，绝不落到 props_json。
 */
export interface UploadErrorSignal {
  phase: UploadRequestPhase;
  /** 是否收到 HTTP 响应（含 200 业务错误信封） */
  hasResponse: boolean;
  httpStatus?: number;
  axiosCode?: string;
  message?: string;
  /** HTTP 200 但响应信封 code !== 0 时的业务码 */
  backendCode?: number;
}

export interface UploadFailureVerdict {
  failure_stage: UploadFailureStage;
  failure_reason: UploadFailureReason;
  http_status?: number;
  backend_code?: number;
}

export function isUploadFailureStage(v: unknown): v is UploadFailureStage {
  return typeof v === 'string' && (UPLOAD_FAILURE_STAGES as readonly string[]).includes(v);
}

export function isUploadFailureReason(v: unknown): v is UploadFailureReason {
  return typeof v === 'string' && (UPLOAD_FAILURE_REASONS as readonly string[]).includes(v);
}

const TIMEOUT_RE = /ECONNABORTED|ETIMEDOUT|timeout|timed out|请求超时/i;
const NETWORK_RE = /ECONNREFUSED|ENOTFOUND|ENETUNREACH|ERR_NETWORK|Network Error|无法连接/i;

/**
 * 把 axios/业务错误归类为受控 (stage, reason)。
 * 判定优先级：业务错误码 > HTTP 响应 > 无响应（超时 > 网络 > 未知）。
 */
export function classifyUploadError(signal: UploadErrorSignal): UploadFailureVerdict {
  const { phase, hasResponse, httpStatus, axiosCode, message, backendCode } = signal;

  // 1) HTTP 200 但业务信封 code !== 0（参数校验/限流等，服务端已明确拒绝）
  if (backendCode !== undefined && backendCode !== 0) {
    return {
      failure_stage: 'business_error',
      failure_reason: 'backend_reject',
      ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
      backend_code: backendCode,
    };
  }

  // 2) 有 HTTP 响应（4xx / 5xx / 其他）
  if (hasResponse) {
    const reason: UploadFailureReason =
      typeof httpStatus === 'number' && httpStatus >= 500
        ? 'http_5xx'
        : typeof httpStatus === 'number' && httpStatus >= 400
          ? 'http_4xx'
          : 'http_other';
    return {
      failure_stage: 'server_reject',
      failure_reason: reason,
      ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
    };
  }

  // 3) 无响应：请求根本没到后端（连不上 / 超时 / 其它）
  const text = `${axiosCode ?? ''} ${message ?? ''}`;
  if (TIMEOUT_RE.test(text)) {
    return {
      failure_stage: phase === 'account_create' ? 'account_create' : 'transport',
      failure_reason: 'timeout',
    };
  }
  if (NETWORK_RE.test(text)) {
    return {
      failure_stage: phase === 'account_create' ? 'account_create' : 'transport',
      failure_reason: 'network_error',
    };
  }
  return { failure_stage: 'unknown', failure_reason: 'unknown' };
}

/**
 * 客户端生成的上传尝试 ID。仅用于埋点关联 + 服务端幂等作用域，
 * 不是安全凭证，也不含任何用户内容。
 */
export function newUploadAttemptId(): string {
  let hex = '';
  for (let i = 0; i < 12; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return `ua_${Date.now().toString(36)}_${hex}`;
}
