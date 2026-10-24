/**
 * OCR 服务（INF-04）
 * 复用 LLM 抽象层视觉模型；无视觉模型时 Mock 兜底返回占位题干（ocr_status='partial'）。
 * 文本入口（text/paste）无需 OCR，直接复用原文，ocr_status='success'。
 */
import { getProvider } from '../llm';
import { MockProvider } from '../llm/mockProvider';
import { env } from '../../config/env';
import { MOCK_ATTR_MODEL_VERSION } from '@aicorrection/shared';
import type { OcrStatus } from '@aicorrection/shared';

export interface OcrResult {
  ocr_status: OcrStatus;
  question: string;
}

const OCR_PROMPT =
  '请将图片中的题目转为纯文本标准化题干，仅输出题目正文，不要解释、不要作答。';

/** 文本入口：原文即为题干，无需 OCR。 */
export function recognizeText(rawText?: string): OcrResult {
  const question = (rawText ?? '').trim();
  return {
    ocr_status: question ? 'success' : 'fail',
    question,
  };
}

/** 图片入口：调用视觉模型；Mock 返回 partial 占位题干。 */
export async function recognizeImage(
  imageBuffer: Buffer
): Promise<OcrResult> {
  const provider = getProvider();
  const base64 = imageBuffer.toString('base64');
  try {
    const res = await provider.chatWithImage(base64, OCR_PROMPT);
    const isMock = provider.name === 'mock' || provider.name === MOCK_ATTR_MODEL_VERSION;
    const text = (res.text ?? '').trim();
    if (isMock) {
      // Mock 视觉模型：占位题干，标记 partial，闭环仍可继续演示
      return { ocr_status: 'partial', question: text };
    }
    if (!text) {
      return { ocr_status: 'fail', question: '' };
    }
    return { ocr_status: 'success', question: text };
  } catch {
    // 视觉模型不可用（如 VISION_MODEL 未拉取）→ Mock 占位题干兜底，保证图片入口仍可演示
    if (env.AUTO_FALLBACK_TO_MOCK) {
      const mock = new MockProvider();
      const r = await mock.chatWithImage(base64, OCR_PROMPT);
      return { ocr_status: 'partial', question: r.text };
    }
    return { ocr_status: 'fail', question: '' };
  }
}
