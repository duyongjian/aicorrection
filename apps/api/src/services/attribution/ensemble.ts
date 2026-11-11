/**
 * 方案2·本地多模型编排归因（免费、本地、零外发默认）
 *
 * 思路（模型规划 → 调用专精小模型 → 汇总）：
 *  1. makeSpecialists()：按学科把题目路由到 2 个「专精小模型」（本地 8096 推理 / 8094 广知 /
 *     8097 快推理）+ 各自领域专家 persona system 前缀，让每个小模型扮演该学科专家。
 *  2. 并行调用各专精模型（skipPersist，不落库），得到各自的「正确选项 + 错因/讲解」。
 *  3. 多数投票：聚合各专家给出的正确选项字母，取多数；平票则留空由合成器定夺。
 *  4. 可选事实 grounding：
 *     - 本地 RAG specialist（enableRagSpecialist）：强制调用本地题库 RAG（force 模式，绕过
 *       全局 RAG_ENABLED 闸门）作为"事实 specialist"，用权威题库结论纠正专精小模型共享的知识盲区
 *       （英语语法/史实/政治概念/408 考点）。完全离线、零外发、免费，契合数据主权铁律，是首选 grounding。
 *     - 可选 web grounding（enableWebSearch）：仅用户显式开启时才用联网检索片段作核实参考
 *       （默认关，符合数据主权铁律）。与 RAG 二选一或并用，RAG 优先采信。
 *  5. 合成器（默认 8096 思考模型）综合「各专家意见 + 多数票 + 事实参考」产出最终归因文本，
 *     经 generateAttribution(precomputedText) 复用同一套解析/校验/落库逻辑落盘。
 *
 * 设计边界（务必知悉）：本地小模型共享知识盲区（英语/史实/政治概念），纯模型集成改善的是
 * 推理稳健性与交叉校验；要真正补知识盲区，须把「事实 specialist」接入第 4 步——现已实现为
 * 本地 RAG（首选，离线零外发）与可选 web（次选）。方案1（大模型 API）则是更直接的知识补强路径。
 */
import { env } from '../../config/env';
import { OllamaProvider } from '../llm/ollamaProvider';
import type { LlmProvider } from '../llm/provider';
import { generateAttribution, type AttrInput } from './attributionService';
import { retrieveWebSearch } from '../websearch/webSearchService';
import { retrieveReferences } from '../rag/ragService';
import * as rt from '../admin/runtimeSettings';
import { withTimeout } from '../../utils/promise';
import { TIMEOUT } from '../../config/timeout';
import {
  ATTR_SYSTEM,
  ATTR_SYSTEM_NOANSWER,
  attrUserPrompt,
  extractClaimedLetter,
} from './prompt';

interface SpecialistCfg {
  id: string;
  provider: LlmProvider;
  expertSystem: string;
}

/** 构造一个本地小模型 provider（OpenAI 兼容，零额外依赖）。 */
function ep(url: string, model: string, think: boolean): LlmProvider {
  return new OllamaProvider({ baseUrl: url, textModel: model, apiKey: '', disableThinking: think });
}

/** 按学科路由：返回该学科应咨询的专精小模型 + 领域专家 persona。 */
function makeSpecialists(subject: string): SpecialistCfg[] {
  const s = subject || '';
  // 各端点/模型可被管理后台运行时覆盖（runtimeSettings），未覆盖时回落 env。
  const think = ep(
    rt.getStr('ENSEMBLE_THINK_URL', env.ENSEMBLE_THINK_URL),
    rt.getStr('ENSEMBLE_THINK_MODEL', env.ENSEMBLE_THINK_MODEL),
    false
  );
  const broad = ep(
    rt.getStr('ENSEMBLE_BROAD_URL', env.ENSEMBLE_BROAD_URL),
    rt.getStr('ENSEMBLE_BROAD_MODEL', env.ENSEMBLE_BROAD_MODEL),
    true
  );
  const fast = ep(
    rt.getStr('ENSEMBLE_FAST_URL', env.ENSEMBLE_FAST_URL),
    rt.getStr('ENSEMBLE_FAST_MODEL', env.ENSEMBLE_FAST_MODEL),
    true
  );
  const eng = '你是一位英语语言学与语法专家，尤擅虚拟语气、倒装、主谓一致、词汇辨析等考研英语易错点。';
  const pol = '你是一位考研政治专家，熟悉毛中特、中国近现代史纲要、马克思主义基本原理的标准结论与权威表述。';
  const math = '你是一位数学分析专家，擅长极限、积分、级数、隐函数求导与线代概率。';
  const cs = '你是一位计算机组成原理与操作系统专家，擅长死锁、Cache 映射、内存管理与 408 考点。';
  if (/英语/.test(s))
    return [
      { id: 'think-en', provider: think, expertSystem: eng },
      { id: 'broad-en', provider: broad, expertSystem: eng },
    ];
  if (/政治|史纲|马原|毛中特/.test(s))
    return [
      { id: 'think-pol', provider: think, expertSystem: pol },
      { id: 'broad-pol', provider: broad, expertSystem: pol },
    ];
  if (/数学|线代|概率/.test(s))
    return [
      { id: 'think-math', provider: think, expertSystem: math },
      { id: 'fast-math', provider: fast, expertSystem: math },
    ];
  if (/计组|OS|计算机|408/.test(s))
    return [
      { id: 'broad-cs', provider: broad, expertSystem: cs },
      { id: 'think-cs', provider: think, expertSystem: cs },
    ];
  return [
    { id: 'think', provider: think, expertSystem: '' },
    { id: 'broad', provider: broad, expertSystem: '' },
  ];
}

export async function generateEnsembleAttribution(input: AttrInput) {
  const specs = makeSpecialists(input.subject ?? '');
  const hasAnswer = Boolean(input.user_answer && input.user_answer.trim());

  // 1) 并行跑各专精小模型（skipPersist，不落库；lightweight 模式自动跳过 RAG/联网检索）
  const results = await Promise.all(
    specs.map(async (sp) => {
      try {
        const r = await generateAttribution({ ...input, providerOverride: sp.provider, skipPersist: true });
        const anyR = r as any;
        return {
          id: sp.id,
          ok: r.status === 'ok',
          correct: anyR.correct_answer ?? null,
          cause: anyR.cause ?? null,
        };
      } catch {
        return { id: sp.id, ok: false, correct: null, cause: null };
      }
    })
  );
  const ok = results.filter((r) => r.ok && r.correct);

  // 2) 多数投票定字母
  const votes: Record<string, number> = {};
  for (const r of ok) {
    const L = extractClaimedLetter((r.correct as string) ?? '');
    if (L) votes[L] = (votes[L] ?? 0) + 1;
  }
  const majority = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // 3) 可选事实 grounding（web，受 enableWebSearch 闸门；默认关 = 数据主权）
  let webBlock = '';
  if (input.enableWebSearch) {
    const wr = await withTimeout(
      retrieveWebSearch(input.question, { subject: input.subject, enabled: true }),
      env.WEB_SEARCH_TIMEOUT_MS
    ).catch(() => null);
    if (wr && wr.status === 'ok' && wr.items?.length) {
      webBlock = wr.items.map((i) => `- ${i.title}: ${i.snippet}`).join('\n');
    }
  }

  // 3.5) 本地 RAG specialist（首选 grounding，enableRagSpecialist 时强制启用，离线零外发）
  // 用本地题库的权威结论纠正专精小模型共享的知识盲区；force 模式绕过全局 RAG_ENABLED 闸门，
  // 使方案2 的事实 specialist 始终可用（生产 RAG_ENABLED=true 时冗余但无害）。
  let ragBlock = '';
  if (input.enableRagSpecialist) {
    const rr = await withTimeout(
      retrieveReferences(input.question, { subject: input.subject, force: true, topK: env.RAG_TOP_K }),
      env.RAG_TIMEOUT_MS
    ).catch(() => null);
    if (rr && rr.status === 'ok' && rr.items?.length) {
      ragBlock = rr.items
        .map((i) => `- 【${i.knowledge_point}】${i.snippet}`)
        .join('\n');
    }
  }

  // 4) 合成器：综合专家意见 + 多数票 + 事实参考 → 最终文本
  const synthProvider = ep(
    rt.getStr('ENSEMBLE_SYNTH_URL', env.ENSEMBLE_SYNTH_URL),
    rt.getStr('ENSEMBLE_SYNTH_MODEL', env.ENSEMBLE_SYNTH_MODEL),
    false
  );
  const expertSummary = results
    .map(
      (r) =>
        `【专家 ${r.id}${r.ok ? '' : '（调用失败）'}】正确选项：${r.correct ?? '无'}\n错因/讲解要点：${r.cause ?? '无'}`
    )
    .join('\n');
  const synthSystemTail = `你是归因终审合成器。下面有多位领域专家的独立判断，请综合它们${majority ? `，并优先采信多数票结论（正确选项应为 ${majority}）` : ''}。${ragBlock ? `\n\n【题库知识库参考（权威结论，可采信以纠正专家判断）】\n${ragBlock}` : ''}${webBlock ? `\n\n【联网事实参考（仅供核实，不照搬）】\n${webBlock}` : ''}\n请输出与正常归因完全一致的结构：有作答时恰好三行（错因/知识点/本质），无作答时五段（正确答案/正确推导/常见陷阱/知识点/本质）。`;
  const synthMessages = [
    {
      role: 'system' as const,
      content: (hasAnswer ? ATTR_SYSTEM : ATTR_SYSTEM_NOANSWER) + '\n\n' + synthSystemTail,
    },
    {
      role: 'user' as const,
      content: attrUserPrompt(input.question, input.user_answer, expertSummary, { teach: !hasAnswer }),
    },
  ];
  let synthText: string | null = null;
  let synthModel = synthProvider.name;
  try {
    const synthRes = await withTimeout(
      synthProvider.chat(synthMessages, { maxTokens: hasAnswer ? 1536 : 1792 }),
      TIMEOUT.ATTRIBUTION_MS
    );
    synthText = synthRes.text;
    synthModel = synthRes.model || synthProvider.name;
  } catch {
    synthText = null;
  }

  // 5) 复用核心解析/校验/落库：合成成功 → precomputedText 进入；失败 → 合成器模型走正常单模型归因兜底
  if (synthText && synthText.trim()) {
    return generateAttribution({
      ...input,
      providerOverride: synthProvider,
      precomputedText: synthText,
      precomputedModelVersion: `ensemble-synth:${synthModel}`,
    });
  }
  return generateAttribution({ ...input, providerOverride: synthProvider });
}
