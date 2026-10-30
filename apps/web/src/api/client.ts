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
  ReviewPendingResponse,
  ReviewWriteRequest,
  ReviewWriteResponse,
} from '@aicorrection/shared';

/**
 * 全局请求超时。必须 >= 后端 ATTRIBUTION_TIMEOUT_MS(当前 300s)，且 >=
 * 本地推理模型冷启动 + 单次归因耗时。否则会抢在模型返回前 abort 连接，
 * 前端误报"归因请求失败"（实际模型仍在算）。
 * 按分析强模型 Qwen3.8-27B @ RTX4060 8GB（~3 tok/s，thinking 关闭实测 161s）
 * 标定为 300s，与后端保持一致。本项目是离线本地重推理应用，该超时可接受。
 */
const REQUEST_TIMEOUT_MS = 300_000;

const http = axios.create({
  baseURL: '/api/v1',
  timeout: REQUEST_TIMEOUT_MS,
});

// 统一错误处理：把后端 {code,message}（业务错误）与 HTTP 错误转成可读 Error，
// 便于 UI 显示具体原因（而不是笼统的“上传失败”）。
http.interceptors.response.use(
  (r) => {
    const body = r.data as { code?: number; message?: string } | undefined;
    if (body && typeof body.code === 'number' && body.code !== 0) {
      return Promise.reject(new Error(body.message || `业务错误（${body.code}）`));
    }
    return r;
  },
  (err) => {
    const resp = (err as { response?: { data?: { message?: string }; status?: number } })
      .response;
    if (resp?.data?.message) return Promise.reject(new Error(resp.data.message));
    if (resp?.status) return Promise.reject(new Error(`请求失败（HTTP ${resp.status}）`));
    return Promise.reject(err);
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
