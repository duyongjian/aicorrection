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
import fs from 'node:fs';
import path from 'node:path';
import { MOCK_ATTR_MODEL_VERSION } from '@aicorrection/shared';
import type { AttributionData } from '@aicorrection/shared';
import type { LlmMessage, LlmResult } from '../llm/provider';

/**
 * 分析强模型（27B）失败本地告警（plan C 的"告警"环节）。
 * 仅落本地 data/analysis_failure.log，不离开本机；best-effort，失败不影响主流程。
 * 运维/自动重启可监听此日志触发 8085 实例重建。
 */
function logAnalysisFailure(entry: {
  ts: string;
  model: string;
  attempts: number;
  error: string;
}): void {
  try {
    fs.appendFileSync(
      path.join(env.DATA_DIR, 'analysis_failure.log'),
      JSON.stringify(entry) + '\n'
    );
  } catch {
    /* 审计失败不影响主流程 */
  }
}
import {
  ATTR_SYSTEM,
  ATTR_SYSTEM_NOANSWER,
  attrUserPrompt,
  buildReferenceBlock,
  buildWebSearchBlock,
  parseAttrTriple,
  parseTeaching,
  type ParsedTeaching,
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

  // 是否有用户作答：有作答 → 诊断模式（错因/知识点/本质 三行）；
  // 无作答 → 讲解模式（正确答案/正确推导/常见陷阱 + 知识点/本质）。
  const hasAnswer = Boolean(input.user_answer && input.user_answer.trim());

  // 题库 RAG 参考块（P1）：带独立超时 RAG_TIMEOUT_MS（默认 8s）。超时/失败→不注入参考块，归因照常进行。
  // 注：web 搜索在 RAG 之后发起（用 RAG 命中的知识点作检索词），故此处只起 RAG。
  const ragPromise = withTimeout(
    retrieveReferences(input.question, { subject: input.subject }),
    env.RAG_TIMEOUT_MS
  ).catch(() => null);

  // 知识锚点（grounding）：仅当题干/作答命中特定知识点（如非谓语分词作状语）时，
  // 在 system 消息尾部拼接人工核查要点，引导模型先复核主谓语态、避免系统性误判。
  // 锚点不计入最终三行结论，也不出现契约标记词，故不污染 parseAttrTriple 解析。
  const refs = getKnowledgeReferences(input.question, input.user_answer, input.subject);
  const refsBlock = refs.length
    ? '\n\n【知识锚点（仅供你参考 grounding，不要原样复述，也不计入最终三行结论）】\n' +
      refs.join('\n---\n')
    : '';

  // 等 RAG 结果返回（仅用于拼 user 消息 + 派生联网检索词）
  const refResult = await ragPromise;
  const referenceBlock = refResult ? buildReferenceBlock(refResult) : '';
  // 用 RAG 命中的首个知识点作为联网检索词（远比原始题干精准），提升召回质量（P2 增强）。
  const topKp =
    refResult && refResult.status === 'ok' && refResult.items?.[0]?.knowledge_point
      ? refResult.items[0].knowledge_point
      : undefined;
  // 联网搜索参考块（P2）：默认开启（脱敏保证不变）；失败/超时/关闭→不注入，归因照常进行。
  // 检索词优先用 RAG 知识点，无命中则退回脱敏题干。
  const webPromise = withTimeout(
    retrieveWebSearch(input.question, {
      subject: input.subject,
      userAnswer: input.user_answer,
      knowledgePoint: topKp,
    }),
    env.WEB_SEARCH_TIMEOUT_MS
  ).catch(() => null);
  // 等联网搜索结果返回（P2，仅用于拼 user 消息）
  const webResult = await webPromise;
  const webBlock = webResult ? buildWebSearchBlock(webResult) : '';
  const userContent = attrUserPrompt(
    input.question,
    input.user_answer,
    referenceBlock ? `${referenceBlock}\n${webBlock}` : webBlock,
    { teach: !hasAnswer }
  );

  const messages: LlmMessage[] = [
    { role: 'system', content: (hasAnswer ? ATTR_SYSTEM : ATTR_SYSTEM_NOANSWER) + refsBlock },
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
    // 按模式校验：诊断模式查三行齐全；讲解模式查核心三段（正确答案/正确推导/常见陷阱）齐全。
    const valid = hasAnswer
      ? parseAttrTriple(r.text).hasThree
      : parseTeaching(r.text).hasCore;
    if (!valid) return false;
    text = r.text;
    latencyMs = r.latencyMs;
    modelVersion = `${MOCK_ATTR_MODEL_VERSION}-fallback`;
    usedFallback = true;
    isMock = true;
    return true;
  };

  // 27B 出问题"先重试再降级"（plan C 前置）：仅对"传输/连接"类快失败重试
  // （模型崩了/没起来/瞬间 5xx）；对完整生成超时（模型在跑但慢）不重试 —— 再等一个完整
  // 超时预算无意义。重试耗尽仍失败 → 诚实降级（analyzing）+ 本地告警（供运维/自动重启 8085）。
  let analysisRes: LlmResult | null = null;
  let lastErr: unknown = null;
  // 讲解模式（无作答）需容纳"正确推导"多步内容，放宽到 1792；诊断模式维持 1536。
  const maxTokens = hasAnswer ? 1536 : 1792;
  for (let attempt = 0; attempt <= env.ANALYSIS_MAX_RETRIES; attempt++) {
    try {
      analysisRes = await withTimeout(
        // max_tokens：按分析强模型 ~3 tok/s 估算，4096 token 需 ~1400s，
        // 远超超时预算（等于必然超时）；实测正常归因仅 ~93-448 token，
        // 留约 3x 余量。真触发截断时由解析判定缺项 → 返回 incomplete（诚实失败，绝不补假数据）。
        provider.chat(messages, { maxTokens }),
        TIMEOUT.ATTRIBUTION_MS
      );
      break;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = /timeout|timed out|aborted|abort/i.test(msg);
      if (attempt < env.ANALYSIS_MAX_RETRIES && !isTimeout) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); // 短退避后重试
        continue;
      }
      break;
    }
  }

  if (analysisRes) {
    text = analysisRes.text;
    latencyMs = analysisRes.latencyMs;
    if (provider.name !== 'mock') modelVersion = analysisRes.model || provider.name;
  } else {
    // 重试耗尽 → plan C：诚实降级 + 本地告警（不编造、不静默）。
    logAnalysisFailure({
      ts: new Date().toISOString(),
      model: env.ANALYSIS_MODEL,
      attempts: env.ANALYSIS_MAX_RETRIES + 1,
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    // 真实模型不可达 → 运行时 Mock 兜底（仅当显式开启）；否则返回 analyzing 降级态。
    if (!(await fallbackToMock())) {
      return { status: 'analyzing' };
    }
  }

  // 按模式解析：有作答走诊断三行；无作答走讲解五段。
  if (hasAnswer) {
    let parsed = parseAttrTriple(text ?? '');
    if (!parsed.hasThree && !usedFallback) {
      // 真实模型输出缺项 → 再尝试 Mock 兜底；仍失败则不展示残缺结果
      await fallbackToMock();
      parsed = parseAttrTriple(text ?? '');
    }
    if (!parsed.hasThree) return { status: 'incomplete' };

    const attributionId = generateAttributionId();
    createAttribution({
      attribution_id: attributionId,
      loop_id: input.loop_id,
      anon_user_id: input.anon_user_id,
      mistake_id: input.mistake_id ?? null,
      // K1.3 盲评回放：把题干与作答一起落库，否则事后无法复盘"学生怎么答/AI 怎么判"
      question: input.question,
      user_answer: input.user_answer?.trim() || null,
      cause: parsed.cause ?? null,
      knowledge_point: parsed.knowledge_point ?? null,
      essence: parsed.essence ?? null,
      correct_answer: null,
      derivation: null,
      pitfalls: null,
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

  // 无作答：讲解模式（ATT-01b）
  const teaching = parseTeaching(text ?? '');
  if (!teaching.hasCore) {
    // 真实模型缺项 → 诚实降级（Mock 兜底产出的是三行格式，无法补足教学字段）。
    return { status: 'incomplete' };
  }

  const attributionId = generateAttributionId();
  createAttribution({
    attribution_id: attributionId,
    loop_id: input.loop_id,
    anon_user_id: input.anon_user_id,
    mistake_id: input.mistake_id ?? null,
    // K1.3 盲评回放：题干照存，user_answer 在讲解模式下为空
    question: input.question,
    user_answer: null,
    // 无作答无法定位个人错因，错因行给状态说明；知识点/本质复用讲解内容。
    cause: '（未提供作答，已给出本题讲解）',
    knowledge_point: teaching.knowledge_point ?? null,
    essence: teaching.essence ?? null,
    correct_answer: teaching.correct_answer ?? null,
    derivation: teaching.derivation ?? null,
    pitfalls: teaching.pitfalls ?? null,
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
    cause: '（未提供作答，已给出本题讲解）',
    knowledge_point: teaching.knowledge_point ?? '',
    essence: teaching.essence ?? '',
    attr_model_version: modelVersion,
    attr_latency_ms: latencyMs,
    complete: true,
    references: refResult ?? undefined,
    webSearch: webResult ?? undefined,
    correct_answer: teaching.correct_answer ?? undefined,
    derivation: teaching.derivation ?? undefined,
    pitfalls: teaching.pitfalls ?? undefined,
  };
}
