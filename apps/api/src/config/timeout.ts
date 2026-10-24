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
} as const;
