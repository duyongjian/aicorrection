/**
 * HTTP 客户端封装：account / upload / attribution / rate / followup / track / dashboard / review
 * 统一以 /api/v1 为前缀（开发态由 Vite 代理转发到 :3001）。
 */
import axios from 'axios';
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
    const resp = (err as { response?: { data?: { message?: string }; status?: number } })
      .response;
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
