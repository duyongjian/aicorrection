/**
 * 归因服务（ATT-01 / ATT-02）
 * 三项生成 + 超时降级（status:'analyzing'）+ 缺项判定（status:'incomplete'）。
 * 注：降级态以 HTTP 200 + data.status 表达（前后端一致，见 §7.6 取舍说明）。
 * T4: 当 provider 为 mock 或 fallback 时，打标 is_mock=true。
 */
import { getAnalysisProvider } from '../llm';
import { MockProvider } from '../llm/mockProvider';
import { env } from '../../config/env';
import { createAttribution } from '../../models/attributionModel';
import { generateAttributionId } from '../../utils/id';
import { withTimeout } from '../../utils/promise';
import { TIMEOUT } from '../../config/timeout';
import { MOCK_ATTR_MODEL_VERSION } from '@aicorrection/shared';
import type { AttributionData } from '@aicorrection/shared';
import type { LlmMessage } from '../llm/provider';
import {
  ATTR_SYSTEM,
  attrUserPrompt,
  parseAttrTriple,
} from './prompt';

export interface AttrInput {
  loop_id: string;
  anon_user_id: string;
  question: string;
  user_answer?: string;
  mistake_id?: string | null;
  is_internal?: boolean;
}

export async function generateAttribution(
  input: AttrInput
): Promise<AttributionData> {
  // 归因分析走独立的分析 provider（ANALYSIS_*，可指向另一个本地强模型）
  const provider = getAnalysisProvider();
  const userContent = attrUserPrompt(input.question, input.user_answer);
  const messages: LlmMessage[] = [
    { role: 'system', content: ATTR_SYSTEM },
    { role: 'user', content: userContent },
  ];

  let text: string | null = null;
  let latencyMs = 0;
  let modelVersion =
    provider.name === 'mock' ? MOCK_ATTR_MODEL_VERSION : (provider.name ?? 'unknown');
  let usedFallback = false;
  /** 是否本次使用了 mock provider（含 fallback） */
  let isMock = provider.name === 'mock';

  /** 运行时 Mock 兜底：真实模型不可用/超时/输出不合格式时，保证无可用模型也能跑通闭环。 */
  const fallbackToMock = async (): Promise<boolean> => {
    if (!env.AUTO_FALLBACK_TO_MOCK || provider.name === 'mock') return false;
    const mock = new MockProvider();
    const r = await mock.chat(messages, { maxTokens: 800 });
    const mp = parseAttrTriple(r.text);
    if (!mp.hasThree) return false;
    text = r.text;
    latencyMs = r.latencyMs;
    modelVersion = `${MOCK_ATTR_MODEL_VERSION}-fallback`;
    usedFallback = true;
    isMock = true;
    return true;
  };

  try {
    const res = await withTimeout(
      // max_tokens 1536：按分析强模型 ~3 tok/s 估算，4096 token 需 ~1400s，
      // 远超 300s 超时预算（等于必然超时）；实测正常归因仅 448 token，
      // 1536 留约 3x 余量。真触发截断时由 parseAttrTriple 判定缺项 → 返回
      // incomplete（诚实失败，绝不补假数据）。
      provider.chat(messages, { maxTokens: 1536 }),
      TIMEOUT.ATTRIBUTION_MS
    );
    text = res.text;
    latencyMs = res.latencyMs;
    if (provider.name !== 'mock') modelVersion = res.model || provider.name;
  } catch {
    // 真实模型超时/异常 → 运行时 Mock 兜底；仅当关闭兜底时才返回 analyzing 降级态
    if (!(await fallbackToMock())) {
      return { status: 'analyzing' };
    }
  }

  let parsed = parseAttrTriple(text ?? '');
  if (!parsed.hasThree && !usedFallback) {
    // 真实模型输出缺项 → 再尝试 Mock 兜底；仍失败则标记待审，不展示残缺结果
    await fallbackToMock();
    parsed = parseAttrTriple(text ?? '');
  }

  if (!parsed.hasThree) {
    return { status: 'incomplete' };
  }

  const attributionId = generateAttributionId();
  createAttribution({
    attribution_id: attributionId,
    loop_id: input.loop_id,
    anon_user_id: input.anon_user_id,
    mistake_id: input.mistake_id ?? null,
    cause: parsed.cause ?? null,
    knowledge_point: parsed.knowledge_point ?? null,
    essence: parsed.essence ?? null,
    attr_model_version: modelVersion,
    attr_latency_ms: latencyMs,
    rate_action: null,
    inaccurate_reason: null,
    expert_consistency: null,
    expert_accuracy: null,
    knowledge_point_id: null,
    cause_id: null,
    kq_taxonomy_version: 'v0.1',
    cause_taxonomy_version: 'v0.1',
    is_mock: isMock ? 1 : 0,
    is_internal: input.is_internal ? 1 : 0,
    created_at: new Date().toISOString(),
  });

  return {
    status: 'ok',
    attribution_id: attributionId,
    loop_id: input.loop_id,
    cause: parsed.cause as string,
    knowledge_point: parsed.knowledge_point as string,
    essence: parsed.essence as string,
    attr_model_version: modelVersion,
    attr_latency_ms: latencyMs,
    complete: true,
  };
}
