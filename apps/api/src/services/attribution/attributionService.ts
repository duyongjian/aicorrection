/**
 * 归因服务（ATT-01 / ATT-02）
 * 三项生成 + 超时降级（status:'analyzing'）+ 缺项判定（status:'incomplete'）。
 * 注：降级态以 HTTP 200 + data.status 表达（前后端一致，见 §7.6 取舍说明）。
 * T4: 当 provider 为 mock 或 fallback 时，打标 is_mock=true。
 */
import { getAnalysisProvider, getCloudProvider } from '../llm';
import { MockProvider } from '../llm/mockProvider';
import { env } from '../../config/env';
import { isFeatureEnabled } from '../../config/rollout';
import { createAttribution } from '../../models/attributionModel';
import { insertEvent, markExposureMockFlag } from '../../models/analyticsEventModel';
import { generateAttributionId, generateEventId } from '../../utils/id';
import { assignCohort, type CohortAssignment } from '../rollout/cohortService';
import { withTimeout } from '../../utils/promise';
import { TIMEOUT } from '../../config/timeout';
import fs from 'node:fs';
import path from 'node:path';
import { MOCK_ATTR_MODEL_VERSION } from '@aicorrection/shared';
import type { AttributionData } from '@aicorrection/shared';
import type { LlmMessage, LlmResult, LlmProvider } from '../llm/provider';

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
  verifyAnswerLetter,
  extractClaimedLetter,
  type ParsedTeaching,
} from './prompt';
import { verifyAnswer } from './mathVerify';
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
  /** 用户显式开启联网搜索（前端开关逐次确认）。 */
  enableWebSearch?: boolean;
  /**
   * 下列字段为方案2（多模型编排）/ 集成路径内部钩子，正常外部调用无需传：
   *  - providerOverride：指定本次归因使用的 LLM provider（专精小模型 / 合成器）。
   *  - skipPersist：仅取模型结论、不落库（专精小模型子调用时避免写入垃圾行）。
   *  - precomputedText：跳过模型调用，直接使用给定文本进入解析/校验/落库
   *    （合成器已生成最终文本时，复用同一套解析与持久化逻辑，避免重复实现）。
   *  - precomputedModelVersion：precomputedText 对应的模型版本标识。
   */
  providerOverride?: LlmProvider;
  skipPersist?: boolean;
  precomputedText?: string;
  precomputedModelVersion?: string;
  /**
   * 方案2·RAG specialist 开关（集成路径内部钩子）。设为 true 时，编排层在合成阶段强制
   * 调用本地题库 RAG（retrieveReferences 的 force 模式，绕过全局 RAG_ENABLED 闸门）作为
   * "事实 specialist" 补强知识盲区（英语语法/史实/政治概念/408 考点）。默认 false 时不接入，
   * 便于做"集成无 RAG"vs"集成+RAG"的对照实验。
   */
  enableRagSpecialist?: boolean;
}

export async function generateAttribution(
  input: AttrInput
): Promise<AttributionData> {
  // 归因分析走独立的分析 provider（ANALYSIS_*，可指向另一个本地强模型）；
  // 方案1(cloud) 走大模型 API；集成路径(providerOverride) 用调用方指定的专精/合成 provider。
  const provider =
    input.providerOverride ??
    (env.ATTRIBUTION_STRATEGY === 'cloud' ? getCloudProvider() : getAnalysisProvider());

  // ── K1.4 灰度：确定性分配 cohort + 计算 treatment 功能开关 ──
  // 默认策略 off → cohort.group='control'、useNewExplanationStyle=false，运行期零行为变化。
  const cohort: CohortAssignment = assignCohort(input.anon_user_id);
  const useNewExplanationStyle = isFeatureEnabled('newExplanationStyle', cohort);
  // 曝光事件（K1.4 安全红线）：仅当 strategy≠off 时，每条归因尝试发一次曝光；
  // 默认 off / kill-switch（strategy 回落 off）下不发曝光，analytics_events 零新增。
  // best-effort，不阻断主流程。
  if (!input.skipPersist && cohort.strategy !== 'off') {
    emitRolloutExposure({
      loopId: input.loop_id,
      anonUserId: input.anon_user_id,
      isInternal: input.is_internal ?? false,
      isMock: provider.name === 'mock',
      feature: 'newExplanationStyle',
      featureOn: useNewExplanationStyle,
      cohort,
    });
  }

  // 是否有用户作答：有作答 → 诊断模式（错因/知识点/本质 三行）；
  // 无作答 → 讲解模式（正确答案/正确推导/常见陷阱 + 知识点/本质）。
  const hasAnswer = Boolean(input.user_answer && input.user_answer.trim());

  // 集成路径子调用（专精小模型 skipPersist / 合成器 precomputed）跳过 RAG/联网检索，
  // 检索与 grounding 由编排层在合成阶段统一处理，省一次网络往返、避免重复外发。
  const lightweight = !!(input.skipPersist || input.precomputedText);
  let refResult: any = null;
  let webResult: any = null;
  let referenceBlock = '';
  let refsBlock = '';
  if (!lightweight) {
    // 题库 RAG 参考块（P1）：带独立超时 RAG_TIMEOUT_MS（默认 8s）。超时/失败→不注入参考块，归因照常进行。
    const ragPromise = withTimeout(
      retrieveReferences(input.question, { subject: input.subject }),
      env.RAG_TIMEOUT_MS
    ).catch(() => null);

    // 知识锚点（grounding）：仅当题干/作答命中特定知识点（如非谓语分词作状语）时，
    // 在 system 消息尾部拼接人工核查要点，引导模型先复核主谓语态、避免系统性误判。
    // 锚点不计入最终三行结论，也不出现契约标记词，故不污染 parseAttrTriple 解析。
    const refs = getKnowledgeReferences(input.question, input.user_answer, input.subject);
    refsBlock = refs.length
      ? '\n\n【知识锚点（仅供你参考 grounding，不要原样复述，也不计入最终三行结论）】\n' +
        refs.join('\n---\n')
      : '';

    // 等 RAG 结果返回（仅用于拼 user 消息 + 派生联网检索词）
    refResult = await ragPromise;
    referenceBlock = refResult ? buildReferenceBlock(refResult) : '';
    // 用 RAG 命中的首个知识点作为联网检索词（远比原始题干精准），提升召回质量（P2 增强）。
    const topKp =
      refResult && refResult.status === 'ok' && refResult.items?.[0]?.knowledge_point
        ? refResult.items[0].knowledge_point
        : undefined;
    // 联网搜索参考块（P2）：WEB_SEARCH_ENABLED 默认 false（P0 数据主权修复）；
    // 仅数据主体显式逐次开启（enableWebSearch）后才外发脱敏检索词。
    const webPromise = withTimeout(
      retrieveWebSearch(input.question, {
        subject: input.subject,
        userAnswer: input.user_answer,
        knowledgePoint: topKp,
        enabled: input.enableWebSearch,
      }),
      env.WEB_SEARCH_TIMEOUT_MS
    ).catch(() => null);
    webResult = await webPromise;
  }
  const webBlock = webResult ? buildWebSearchBlock(webResult) : '';
  const userContent = attrUserPrompt(
    input.question,
    input.user_answer,
    referenceBlock ? `${referenceBlock}\n${webBlock}` : webBlock,
    { teach: !hasAnswer }
  );

  const systemBase = hasAnswer ? ATTR_SYSTEM : ATTR_SYSTEM_NOANSWER;
  // K1.4 treatment 功能：仅当命中（默认关闭，显式开启且仅 treatment 组）才追加"分步追问式讲解"指令。
  const systemExtra = useNewExplanationStyle
    ? '\n\n【讲解风格实验·treatment】请采用"分步追问式"讲解：每给出一步关键结论后，追加一句引导式' +
      '追问（如"你能说出下一步为什么这样算吗？"），促使用户主动反思，而非一次性给全。'
    : '';
  const messages: LlmMessage[] = [
    { role: 'system', content: systemBase + refsBlock + systemExtra },
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
  // 集成路径：合成器已生成最终文本 → 跳过模型调用，直接进入解析/校验/落库（复用同一套逻辑）。
  if (input.precomputedText != null) {
    text = input.precomputedText;
    modelVersion = input.precomputedModelVersion ?? provider.name;
    latencyMs = 0;
  } else {
    let analysisRes: LlmResult | null = null;
  let lastErr: unknown = null;
  // 讲解模式（无作答）需容纳"正确推导"多步内容，放宽到 1792；诊断模式维持 1536。
  const maxTokens = hasAnswer ? 1536 : 1792;
  for (let attempt = 0; attempt <= env.ANALYSIS_MAX_RETRIES; attempt++) {
    try {
      analysisRes = await withTimeout(
        // max_tokens：按历史基线 ~3 tok/s 估算，4096 token 需 ~1400s，
        // 远超超时预算（等于必然超时）；实测正常归因仅 ~93-448 token，
        // 留约 3x 余量（2026-11-05 23:30 部署优化后 decode 已实测 9.76 tok/s，见 k1.5 §4.3）。
        // 真触发截断时由解析判定缺项 → 返回 incomplete（诚实失败，绝不补假数据）。
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

    // 模型无关答案校验（治本）：诊断模式模型不输出正确选项，故直接用独立数值校验
    // 给出正确选项（字母+原文）。覆盖隐函数/极限/积分/级数等可验证题型；其余返回 unknown → null。
    const mvDiag = verifyAnswer(input.question);
    const verifiedCorrect =
      mvDiag.kind === 'verified' && mvDiag.correctOptionText ? mvDiag.correctOptionText : null;

    const attributionId = generateAttributionId();
    if (!input.skipPersist) {
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
      correct_answer: verifiedCorrect,
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
      rollout_group: cohort.group,
      created_at: new Date().toISOString(),
      });
      alignExposureMockFlag(input.loop_id, input.anon_user_id, isMock);
    }
    return {
      status: 'ok',
      attribution_id: attributionId,
      loop_id: input.loop_id,
      cause: parsed.cause as string,
      knowledge_point: parsed.knowledge_point as string,
      essence: parsed.essence as string,
      correct_answer: verifiedCorrect ?? undefined,
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
  // 质量闸门（强化版）：比对"正确答案"指名字母对应公式与模型给出公式是否一致。
  //  - 字母不存在于题干 → 降级 incomplete（诚实提示"暂无法确认选项"）。
  //  - 字母存在但公式命中了别的选项 → 自动纠正字母（模型标错字母，如 (D)→(A)）。
  const letterCheck = verifyAnswerLetter(teaching.correct_answer, input.question);
  if (!letterCheck.ok) {
    return { status: 'incomplete' };
  }
  if (letterCheck.correctedText) {
    teaching.correct_answer = letterCheck.correctedText; // 原地修正标错的选项字母
  }

  // 符号/数值独立校验（治本，模型无关）：在隐函数曲面上数值验证 A~D 哪个选项恒成立。
  // 与模型结论不一致时，以数值校验为准覆盖"正确答案"（字母+公式双保险）。
  // 仅对隐函数求导类题生效；其余题返回 unknown 不干预。
  const mv = verifyAnswer(input.question);
  if (mv.kind === 'verified' && mv.correctLetter && mv.correctOptionText) {
    const claimed = extractClaimedLetter(teaching.correct_answer ?? '');
    if (!claimed || claimed !== mv.correctLetter) {
      console.warn(
        `[mathVerify] 模型答案(${claimed ?? '无'}) 与独立数值校验(${mv.correctLetter}) 不一致，` +
          `已覆盖为 ${mv.correctLetter}；残差=${JSON.stringify(mv.residuals)}`
      );
      teaching.correct_answer = mv.correctOptionText;
    }
  }

  const attributionId = generateAttributionId();
  if (!input.skipPersist) {
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
    rollout_group: cohort.group,
    created_at: new Date().toISOString(),
    });
    alignExposureMockFlag(input.loop_id, input.anon_user_id, isMock);
  }
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

/**
 * K1.4：发一条 rollout_exposure 曝光事件（best-effort，失败不影响主流程）。
 * 把用户所属分组 + 功能命中写入 analytics_events.rollout_group，支撑 treatment vs control 对照。
 * 调用方仅在 cohort.strategy !== 'off' 时调用；默认 off / kill-switch 下不发，保证零写入。
 */
function emitRolloutExposure(p: {
  loopId: string;
  anonUserId: string;
  isInternal: boolean;
  /** 入口时的 provider 判定；最终以归因行 isMock 为准，由 alignExposureMockFlag 对齐。 */
  isMock: boolean;
  feature: string;
  featureOn: boolean;
  cohort: CohortAssignment;
}): void {
  try {
    insertEvent({
      event_id: generateEventId(),
      event_name: 'rollout_exposure',
      anon_user_id: p.anonUserId,
      loop_id: p.loopId,
      session_id: null,
      context_json: JSON.stringify({ feature: p.feature }),
      props_json: JSON.stringify({
        group: p.cohort.group,
        strategy: p.cohort.strategy,
        pct: p.cohort.pct,
        feature: p.feature,
        feature_on: p.featureOn,
      }),
      ts_utc: new Date().toISOString(),
      idempotency_key: `rollout_exposure|${p.anonUserId}|${p.loopId}`,
      received_at: new Date().toISOString(),
      is_mock: p.isMock ? 1 : 0,
      is_internal: p.isInternal ? 1 : 0,
      rollout_group: p.cohort.group,
    });
  } catch {
    /* 埋点失败不影响主流程 */
  }
}

/**
 * 归因结果确定后，把入口已发的曝光事件 is_mock 对齐到最终值（fallback 时会由 0 变 1）。
 * best-effort：默认 off 下无曝光行，UPDATE 影响 0 行，不产生任何写入。
 */
function alignExposureMockFlag(loopId: string, anonUserId: string, isMock: boolean): void {
  try {
    markExposureMockFlag(loopId, anonUserId, isMock);
  } catch {
    /* 埋点修正失败不影响主流程 */
  }
}
