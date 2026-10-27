/**
 * 超时阈值（ATT-02 降级依据）
 * 支持环境变量覆盖：本机小参数模型首加载可能 >25s，默认放宽到 45s
 * （PRD 的 ≤30s 为灰度回校【假设】阈值）。
 */
import { env } from './env';

export const TIMEOUT = {
  /** 归因调用超时 → 返回 status:'analyzing' */
  ATTRIBUTION_MS: env.ATTRIBUTION_TIMEOUT_MS,
  /** 追问调用超时 → 返回兜底补充归因文本 */
  FOLLOWUP_MS: env.FOLLOWUP_TIMEOUT_MS,
  /** OCR 视觉模型超时 → ocr_status='fail' */
  OCR_MS: env.OCR_TIMEOUT_MS,
  /**
   * 本地 OCR（Python 子进程）超时 → 子进程被 kill 并降级。
   * RapidOCR ~2.4s / Paddle 公式 ~1.3s，但 Paddle 模型首次加载/冷启可能 17s+，
   * 故单独放宽到 60s（OCR_MS 是给"整个 OCR 步骤"的 30s，不复用）。
   */
  OCR_LOCAL_MS: env.OCR_LOCAL_TIMEOUT_MS,
} as const;
