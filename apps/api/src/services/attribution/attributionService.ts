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
  buildReferenceBlock,
  buildWebSearchBlock,
  parseAttrTriple,
} from './prompt';
import { getKnowledgeReferences } from './references';
import { retrieveReferences } from '../rag/ragService';
import { retrieveWebSearch } from '../websearch/webSearchService';

export interface AttrInput {
  loop_id: string;
  anon_user_id: string;
  question: string;
  user_answer?: string;
  subject?: string;
  mistake_id?: string | null;
  is_internal?: boolean;
}

export async function generateAttribution(
  input: AttrInput
): Promise<AttributionData> {
  // 归因分析走独立的分析 provider（ANALYSIS_*，可指向另一个本地强模型）
  const provider = getAnalysisProvider();

  // 题库 RAG 参考块（P1）：调用分析 provider **之前**并行发起检索，
  // 带独立超时 RAG_TIMEOUT_MS（默认 8s）。超时/失败→不注入参考块，归因照常进行。
  const ragPromise = withTimeout(
    retrieveReferences(input.question, { subject: input.subject }),
    env.RAG_TIMEOUT_MS
  ).catch(() => null);

  // 联网搜索参考块（P2）：与 RAG 平行发起；独立超时（默认 6s）。默认关闭（数据主权铁律），
  // 开启后只外发脱敏主题词，失败/超时→不注入，归因照常进行。
  const webPromise = withTimeout(
    retrieveWebSearch(input.question, {
      subject: input.subject,
      userAnswer: input.user_answer,
    }),
    env.WEB_SEARCH_TIMEOUT_MS
  ).catch(() => null);

  // 知识锚点（grounding）：仅当题干/作答命中特定知识点（如非谓语分词作状语）时，
  // 在 system 消息尾部拼接人工核查要点，引导模型先复核主谓语态、避免系统性误判。
  // 锚点不计入最终三行结论，也不出现契约标记词，故不污染 parseAttrTriple 解析。
  const refs = getKnowledgeReferences(input.question, input.user_answer, input.subject);
  const refsBlock = refs.length
    ? '\n\n【知识锚点（仅供你参考 grounding，不要原样复述，也不计入最终三行结论）】\n' +
      refs.join('\n---\n')
    : '';

  // 等 RAG 结果返回（仅用于拼 user 消息，不阻塞 provider 准备的其余逻辑）
  const refResult = await ragPromise;
  const referenceBlock = refResult ? buildReferenceBlock(refResult) : '';
  // 等联网搜索结果返回（P2，同样仅用于拼 user 消息）
  const webResult = await webPromise;
  const webBlock = webResult ? buildWebSearchBlock(webResult) : '';
  const userContent = attrUserPrompt(
    input.question,
    input.user_answer,
    referenceBlock ? `${referenceBlock}\n${webBlock}` : webBlock
  );

  const messages: LlmMessage[] = [
    { role: 'system', content: ATTR_SYSTEM + refsBlock },
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
    // P1：带回题库参考块（若本次命中/已检索）。超时或未命中时 refResult 为 null → 不附。
    references: refResult ?? undefined,
    // P2：带回联网搜索参考块（若开启且命中）。关闭/失败/未命中时 webResult 为 null → 不附。
    webSearch: webResult ?? undefined,
  };
}
