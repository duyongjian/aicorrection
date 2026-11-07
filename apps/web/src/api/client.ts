/**
 * HTTP 客户端封装：account / upload / attribution / rate / followup / track / dashboard / review
 * 统一以 /api/v1 为前缀（开发态由 Vite 代理转发到 :3001）。
 */
import axios from 'axios';
import {
  LICENSE_TOKEN_HEADER,
  LICENSE_TOKEN_STORAGE_KEY,
  AUTH_TOKEN_HEADER,
  AUTH_TOKEN_STORAGE_KEY,
  ANON_USER_STORAGE_KEY,
  ERROR_CODES,
} from '@aicorrection/shared';
import type {
  AccountResponse,
  CreateAccountRequest,
  UploadResponse,
  AttributionData,
  AttributionRequest,
  RateResponse,
  RateRequest,
  FollowupResponse,
  FollowupRequest,
  TrackIngestRequest,
  TrackIngestResponse,
  M1Stats,
  UploadFailureBreakdown,
  ReviewPendingResponse,
  ReviewWriteRequest,
  ReviewWriteResponse,
  HistoryItem,
  LicenseRedeemRequest,
  LicenseRedeemResponse,
  LicenseStatusResponse,
  AuthTokenResponse,
  AuthRegisterRequest,
  AuthLoginRequest,
  AuthSmsSendRequest,
  AuthSmsSendResponse,
  AuthSmsVerifyRequest,
  AuthWechatRequest,
  AuthMagicSendRequest,
  AuthMagicSendResponse,
  AuthMagicVerifyRequest,
  AuthStatusResponse,
} from '@aicorrection/shared';

/**
 * 前端全局请求超时。必须严格大于后端 ATTRIBUTION_TIMEOUT_MS（当前 900s），
 * 留出缓冲：否则分析模型一旦 >900s（27B 本地模型在受限显存上极易触发），
 * 后端刚回 `analyzing`、前端已因等长超时 abort，误报"归因请求失败"。
 * 这里取 960s（16min），保证后端任何 200 响应都能被前端完整收到（再慢也只是拿到 analyzing 态）。
 */
const REQUEST_TIMEOUT_MS = 960_000;

const http = axios.create({
  baseURL: '/api/v1',
  timeout: REQUEST_TIMEOUT_MS,
});

/**
 * 凭证自动注入：真实账号 auth token 优先，回落卡密 license token。
 * 仅在同名 header 缺失时补齐，避免覆盖请求自身已设置的值。
 * 二者都设 x-*-token 与 Authorization: Bearer，由后端门禁统一识别。
 */
http.interceptors.request.use((config) => {
  let token: string | null = null;
  try {
    token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || localStorage.getItem(LICENSE_TOKEN_STORAGE_KEY);
  } catch {
    /* 隐私模式 / localStorage 不可用：按无凭证处理 */
  }
  if (token) {
    if (!config.headers[LICENSE_TOKEN_HEADER]) {
      config.headers[LICENSE_TOKEN_HEADER] = token;
    }
    if (!config.headers[AUTH_TOKEN_HEADER]) {
      config.headers[AUTH_TOKEN_HEADER] = token;
    }
    if (!config.headers.Authorization) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

/**
 * 上传错误的**结构化信号**（v0.1.x 上传失败细分埋点）。
 * 只保留判定所需的枚举/数值/axios 原生信息；`message` 仅用于 classifyUploadError
 * 判断超时/网络关键词，**绝不写入埋点 props**（避免把学生内容或错误回显带出本机）。
 */
export interface UploadErrorMeta {
  hasResponse: boolean;
  httpStatus?: number;
  axiosCode?: string;
  message?: string;
  backendCode?: number;
}

const UPLOAD_ERROR_KEY = '__uploadErrorMeta';

function attachMeta(err: unknown, meta: UploadErrorMeta): unknown {
  const e = err instanceof Error ? err : new Error(describeError(err));
  Object.defineProperty(e, UPLOAD_ERROR_KEY, { value: meta, enumerable: false });
  return e;
}

/** 取出响应拦截器附带的结构化信号；非 HTTP 错误（如前端校验）返回 undefined。 */
export function getUploadErrorMeta(e: unknown): UploadErrorMeta | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const v = (e as Record<string, unknown>)[UPLOAD_ERROR_KEY];
  return v && typeof v === 'object' ? (v as UploadErrorMeta) : undefined;
}

// 统一错误处理：把后端 {code,message}（业务错误）与 HTTP 错误转成可读 Error，
// 便于 UI 显示具体原因（而不是笼统的“上传失败”）。
http.interceptors.response.use(
  (r) => {
    const body = r.data as { code?: number; message?: string } | undefined;
    if (body && typeof body.code === 'number' && body.code !== 0) {
      const meta: UploadErrorMeta = {
        hasResponse: true,
        httpStatus: r.status,
        backendCode: body.code,
      };
      return Promise.reject(
        attachMeta(new Error(body.message || `业务错误（${body.code}）`), meta)
      );
    }
    return r;
  },
  (err) => {
    const resp = (
      err as {
        response?: {
          data?: { message?: string; code?: number };
          status?: number;
        };
      }
    ).response;
    // 凭证缺失/被吊销/过期：清理本地身份并通知门禁回到激活页。
    // 这里不做 reload，由 Gate 统一处理，且不影响下方既有的错误转换行为。
    const bodyCode = resp?.data?.code;
    const url = ((err as { config?: { url?: string } }).config?.url || '').split('?')[0];
    const isAuthPublic = /^\/auth\/(login|register|sms\/send|sms\/verify|wechat|magic\/send|magic\/verify|status)(\/|$)/.test(
      url
    );
    if (resp?.status === 401 && !isAuthPublic) {
      const isLicense =
        bodyCode === ERROR_CODES.LICENSE_REQUIRED ||
        bodyCode === ERROR_CODES.LICENSE_REVOKED ||
        bodyCode === ERROR_CODES.LICENSE_EXPIRED;
      const isAuth =
        bodyCode === ERROR_CODES.AUTH_REQUIRED ||
        bodyCode === ERROR_CODES.AUTH_INVALID ||
        bodyCode === ERROR_CODES.AUTH_PROVIDER_NOT_CONFIGURED;
      try {
        if (isLicense) {
          localStorage.removeItem(LICENSE_TOKEN_STORAGE_KEY);
          localStorage.removeItem(ANON_USER_STORAGE_KEY);
        } else if (isAuth) {
          localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
          localStorage.removeItem(ANON_USER_STORAGE_KEY);
        }
      } catch {
        /* localStorage 不可用时忽略 */
      }
      if (isLicense) window.dispatchEvent(new CustomEvent('aicorrection:license-lost'));
      if (isAuth) window.dispatchEvent(new CustomEvent('aicorrection:auth-lost'));
    }
    const e = err as { code?: string; message?: string };
    const meta: UploadErrorMeta = {
      hasResponse: !!resp,
      ...(resp?.status === undefined ? {} : { httpStatus: resp.status }),
      ...(e?.code === undefined ? {} : { axiosCode: e.code }),
      ...(e?.message === undefined ? {} : { message: e.message }),
    };
    if (resp?.data?.message) {
      return Promise.reject(attachMeta(new Error(resp.data.message), meta));
    }
    if (resp?.status) {
      return Promise.reject(attachMeta(new Error(`请求失败（HTTP ${resp.status}）`), meta));
    }
    // 超时（axios 主动 abort）或连接被拒：给出人话，避免笼统"归因请求失败"
    if (e?.code === 'ECONNABORTED' || /timeout|timed out/i.test(e?.message ?? '')) {
      return Promise.reject(
        attachMeta(
          new Error('请求超时：后端分析模型响应过慢或已断开，可重试或改用更小的分析模型'),
          meta
        )
      );
    }
    if (/ECONNREFUSED|ENOTFOUND|Network Error/i.test(e?.message ?? '')) {
      return Promise.reject(
        attachMeta(new Error('无法连接后端服务（:3001），请确认已运行 npm run dev'), meta)
      );
    }
    return Promise.reject(attachMeta(err, meta));
  }
);

/** 提取可读错误信息，供 UI 统一展示。 */
export function describeError(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return '未知错误，请稍后重试';
}

export const api = {
  /** 卡密兑换：成功返回 license_token 与已绑定的匿名身份。 */
  redeemLicense(req: LicenseRedeemRequest): Promise<LicenseRedeemResponse> {
    return http.post('/license/redeem', req).then((r) => r.data.data);
  },

  /** 凭证状态：始终 HTTP 200；active=false 时前端回到激活页。 */
  getLicenseStatus(): Promise<LicenseStatusResponse> {
    return http.get('/license/status').then((r) => r.data.data);
  },

  // ===== v0.2 闭环补全（R04 同类题 / R05 复述本质 / R06 追问验证） =====
  generatePractice(body: {
    loop_id: string;
    anon_user_id: string;
  }): Promise<{
    practice_id: string;
    loop_id: string;
    question_text: string;
    source: 'qbank' | 'llm';
    kp_id: string | null;
  }> {
    return http.post('/learn/practice/generate', body).then((r) => r.data.data);
  },
  gradePractice(body: {
    practice_id: string;
    user_answer: string;
    anon_user_id: string;
  }): Promise<{
    practice_id: string;
    is_correct: 0 | 1;
    graded_by: 'heuristic' | 'llm';
    feedback: string;
  }> {
    return http.post('/learn/practice/grade', body).then((r) => r.data.data);
  },
  submitRestate(body: {
    loop_id: string;
    text: string;
    anon_user_id: string;
  }): Promise<{ loop_id: string; restate_len: number; restate_is_copy: 0 | 1 }> {
    return http.post('/learn/restate', body).then((r) => r.data.data);
  },
  verifyProbe(body: {
    loop_id: string;
    anon_user_id: string;
  }): Promise<{ loop_id: string; question: string }> {
    return http.post('/learn/verify/probe', body).then((r) => r.data.data);
  },
  verify(body: {
    loop_id: string;
    response: string;
    anon_user_id: string;
  }): Promise<{ loop_id: string; result: 'pass' | 'fail' | 'give_up'; feedback: string }> {
    return http.post('/learn/verify', body).then((r) => r.data.data);
  },

  // ===== v0.3 闭环会话流（R07 完成闭环 / 状态聚合） =====
  completeLoop(body: {
    loop_id: string;
    anon_user_id: string;
  }): Promise<{
    loop_id: string;
    loop_complete: boolean;
    progress: number;
    has_upload: boolean;
    has_attribution: boolean;
    rated: boolean;
    has_practice: boolean;
    has_restate: boolean;
    has_verify: boolean;
  }> {
    return http.post('/loop/complete', body).then((r) => r.data.data);
  },
  getLoopSummary(loopId: string): Promise<{
    loop_id: string;
    loop_complete: boolean;
    progress: number;
    has_upload: boolean;
    has_attribution: boolean;
    rated: boolean;
    has_practice: boolean;
    has_restate: boolean;
    has_verify: boolean;
  }> {
    return http.get(`/loop/${loopId}`).then((r) => r.data.data);
  },

  // ===================== 真实账号体系（v0.2 地基） =====================

  /** 邮箱密码注册：返回 auth_token 与已绑定的匿名身份。 */
  registerWithPassword(req: AuthRegisterRequest): Promise<AuthTokenResponse> {
    return http.post('/auth/register', req).then((r) => r.data.data);
  },

  /** 邮箱密码登录。 */
  loginWithPassword(req: AuthLoginRequest): Promise<AuthTokenResponse> {
    return http.post('/auth/login', req).then((r) => r.data.data);
  },

  /** 发送短信验证码（dev 模式响应里带 dev_code 便于自测）。 */
  sendSmsCode(req: AuthSmsSendRequest): Promise<AuthSmsSendResponse> {
    return http.post('/auth/sms/send', req).then((r) => r.data.data);
  },

  /** 短信验证码登录/注册。 */
  verifySmsLogin(req: AuthSmsVerifyRequest): Promise<AuthTokenResponse> {
    return http.post('/auth/sms/verify', req).then((r) => r.data.data);
  },

  /** 微信 OAuth 登录（需服务端配置 WECHAT_APP_ID；未配置返回 AUTH_PROVIDER_NOT_CONFIGURED）。 */
  wechatAuth(req: AuthWechatRequest): Promise<AuthTokenResponse> {
    return http.post('/auth/wechat', req).then((r) => r.data.data);
  },

  /** 发送魔法登录链接（dev 模式响应里带 dev_token 便于自测）。 */
  magicSend(req: AuthMagicSendRequest): Promise<AuthMagicSendResponse> {
    return http.post('/auth/magic/send', req).then((r) => r.data.data);
  },

  /** 魔法链接登录/注册。 */
  magicVerify(req: AuthMagicVerifyRequest): Promise<AuthTokenResponse> {
    return http.post('/auth/magic/verify', req).then((r) => r.data.data);
  },

  /** auth token 状态：始终 HTTP 200；active=false 时回到登录页。 */
  getAuthStatus(): Promise<AuthStatusResponse> {
    return http.get('/auth/status').then((r) => r.data.data);
  },

  /** 当前账号信息（已绑定登录方式等）。 */
  authMe(): Promise<{ anon_user_id: string | null; segment: string | null; providers: string[] }> {
    return http.get('/auth/me').then((r) => r.data.data);
  },

  /** 登出：清除服务端会话（前端同时清本地 token）。 */
  authLogout(): Promise<{ ok: boolean }> {
    return http.post('/auth/logout').then((r) => r.data.data);
  },

  createAccount(req: CreateAccountRequest): Promise<AccountResponse> {
    return http.post('/account', req).then((r) => r.data.data);
  },

  uploadText(payload: Record<string, unknown>): Promise<UploadResponse> {
    return http.post('/upload', payload).then((r) => r.data.data);
  },

  uploadImage(formData: FormData): Promise<UploadResponse> {
    return http.post('/upload', formData).then((r) => r.data.data);
  },

  getAttribution(req: AttributionRequest): Promise<AttributionData> {
    return http.post('/attribution', req).then((r) => r.data.data);
  },

  /** 归因历史列表（FLW-02）：按用户列出最近归因，含关联原图 URL。 */
  getHistory(anonUserId: string, limit = 50): Promise<HistoryItem[]> {
    return http
      .get(
        `/attribution/history?anon_user_id=${encodeURIComponent(
          anonUserId
        )}&limit=${limit}`
      )
      .then((r) => r.data.data);
  },

  rate(loopId: string, req: RateRequest): Promise<RateResponse> {
    return http.post(`/attribution/${loopId}/rate`, req).then((r) => r.data.data);
  },

  followup(loopId: string, req: FollowupRequest): Promise<FollowupResponse> {
    return http
      .post(`/attribution/${loopId}/followup`, req)
      .then((r) => r.data.data);
  },

  track(req: TrackIngestRequest): Promise<TrackIngestResponse> {
    return http.post('/track', req).then((r) => r.data.data);
  },

  dashboardM1(windowDays = 14): Promise<M1Stats> {
    return http.get(`/dashboard/m1?window_days=${windowDays}`).then((r) => r.data.data);
  },

  /** 上传失败细分诊断（v0.1.x 增量，不参与 G1/M5 正式口径）。 */
  dashboardUploadFailures(windowDays = 14): Promise<UploadFailureBreakdown> {
    return http
      .get(`/dashboard/upload-failures?window_days=${windowDays}`)
      .then((r) => r.data.data);
  },

  pendingReviews(
    limit = 20,
    onlyUnrated = true
  ): Promise<ReviewPendingResponse> {
    return http
      .get(`/review/pending?limit=${limit}&only_unrated=${onlyUnrated}`)
      .then((r) => r.data.data);
  },

  writeReview(
    attributionId: string,
    req: ReviewWriteRequest
  ): Promise<ReviewWriteResponse> {
    return http
      .post(`/review/attribution/${attributionId}`, req)
      .then((r) => r.data.data);
  },
};
