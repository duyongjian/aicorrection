#!/usr/bin/env node
/**
 * quality-rubric.mjs — 归因质量量尺（A 层落地，只读、离线）
 *
 * 背景：PRD §1.2 定义产品壁垒 =「归因深度 × 验收严格度」；K1.3 盲评作业指引 §五
 * 已定义 7 列评分口径。但 `auto-eval.mjs` / `attrib-regress.mjs` 只跑「契约格式 +
 * 数值断言 + 错因方向关键词重叠」，完全没有覆盖归因因果性、是否触及本质、讲解
 * 深度完整度。本模块把这条缺口显式化，供质量基线使用。
 *
 * ── 口径纪律（DSR 诚实标定，不可放宽）──────────────────────────────────────
 * 1. **本模块不产出任何质量分**。只产出「结构代理量」(machine proxies)：可观测的
 *    布尔/计数信号，例如「错因里有没有空标签」「推导有几块」「有没有可操作改错指令」。
 *    代理量 ≠ 质量，命中率高不代表归因好。
 * 2. K1.3 的 `是否触及本质(1-5)` / `能否指导改错(1-5)` / `更愿意相信哪一版` /
 *    Cohen's κ 属 **HUMAN_ONLY_DIMENSIONS**：必须由 2 名评分人独立盲评
 *    （`npm run blind:export` → `npm run blind:score`）。本模块恒返回 null，
 *    **绝不用关键词启发式编造 1–5 分**（那会造出 KPI §0.3 R-Gate1 的「假闸门」）。
 * 3. `depth_signal_level` 是由结构信号推出的 L1–L4 **结构等级**，不是深度质量评价；
 *    `depth_target` 是产品侧应逐题标定的目标深度，题集未提供时如实计为
 *    `unspecified`，不自动猜测、不填占位值。
 * 4. `structured_ids_present` 用于暴露 KPI §6.3.1「知识点 / 错因必须以结构化 ID
 *    产出，MVP 期决定、不可后补」的实现缺口；本模块只检测，不擅自发明 taxonomy。
 * 5. 本模块**不参与** auto-eval 的 PASS/PARTIAL/FAIL/INCOMPLETE 判定，也不影响
 *    `scripts/attrib-regress.mjs` 的门禁结果。
 */

/** L1–L4 深度分级定义（描述目标，不等于自动打分）。 */
export const DEPTH_LEVELS = Object.freeze({
  L1: '只给结论或空标签，无推导、无因果机制',
  L2: '给单步计算或表面错因，但未讲清「为什么」',
  L3: '给多步推导或因果机制，并含可操作改错指令 / 原理说明',
  L4: '在 L3 基础上给变式、迁移或举一反三，可复用到同类题',
});

/** 只能由人工盲评产生的维度，机器恒为 null。 */
export const HUMAN_ONLY_DIMENSIONS = Object.freeze([
  'essence_score_1_5',
  'guide_score_1_5',
  'preference',
  'cohens_kappa',
]);

/** 结构代理量键名（全部为布尔 / 计数，无分数）。 */
export const MACHINE_PROXY_KEYS = Object.freeze([
  'contract_complete',
  'cause_has_empty_label',
  'cause_has_mechanism',
  'actionable_hint',
  'explains_why',
  'derivation_blocks',
  'pitfall_section',
  'transfer_hint',
  'structured_ids_present',
  'depth_signal_level',
]);

// ── 词表：只做「有没有」的结构判断，不做语义打分 ────────────────────────────

/** 空标签：K1.3 §五 明确 1 分档「粗心 / 不熟 / 基础不牢」这类说法。 */
const EMPTY_CAUSE_LABELS = Object.freeze([
  /粗心/, /不熟(练)?/, /基础不(牢|扎实)/, /概念(不清|模糊|混淆)[\s，。]*$/,
  /计算(错误|失误|不仔细)/, /审题不(仔细|认真)/, /马虎/, /没有掌握/,
  /掌握不牢/, /不够细心/, /不认真/,
]);

/** 因果机制信号：出现这些词说明错因里至少写了「怎么错的」而非纯标签。 */
const MECHANISM_PATTERNS = Object.freeze([
  /因为/, /由于/, /导致/, /因而/, /从而/, /漏(掉|了)?/, /误(把|将|用|判|认为|当作)/,
  /混淆/, /忽略/, /未(识别|考虑|体现|做|按)/, /(不能|不应|不可)[^。]{0,12}(直接|简单)/,
  /抵消/, /等价/, /阶数/, /主部/, /(应|须)(当|该)?[^。]{0,8}(展开|代入|分解|使用|改用|结合)/,
]);

/** 可操作改错指令：K1.3「能否指导改错」的结构代理（不是该分数本身）。 */
const ACTIONABLE_PATTERNS = Object.freeze([
  /应(该)?(?!.*不应)[^。]{0,16}(展开|代入|分解|改用|使用|结合|先|再|取|令|配平|约分|移项)/,
  /须[^。]{0,16}(展开|代入|分解|改用|使用|结合|先|再|取|令)/,
  /改为/, /改用/, /展开到/, /通分/, /先[^。]{1,16}再/, /(取|令)\s*[^。]{1,20}(为|＝|=)/,
  /正确(做法|解法|推导|步骤)(是|为|：|:)/,
]);

/** 「为什么」解释性语句：只在推导 / 错因 / 陷阱正文里查，排除 essence 字段本身。 */
const EXPLAIN_WHY_PATTERNS = Object.freeze([
  /为什么/, /原理/, /本质(上|是|在于)/, /是因为/, /原因在于/, /根本原因/,
  /这意味着/, /(由此|因此)[^。]{0,12}(说明|可知|得出)/, /(由|根据)[^。]{0,20}(可知|可得|推出)/,
]);

/** 迁移 / 变式信号：L4 的结构代理。 */
const TRANSFER_PATTERNS = Object.freeze([
  /变式/, /迁移/, /举一反三/, /同类题/, /类似题/, /推广到/, /一般化/,
  /换个(题|函数|条件)/, /再比如/, /由此可推广/, /可复用(到|于)/,
]);

/** KPI §6.3.1 要求的结构化 ID（当前三行/五段文本契约里不会出现）。 */
const STRUCTURED_ID_PATTERN = /kq_id|cause_id|kq_ids|knowledge_point_id|错因ID|知识点ID/i;

// ── 工具函数 ────────────────────────────────────────────────────────────────

function hasAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

function countDerivationBlocks(derivation) {
  if (!derivation) return 0;
  const mathBlocks = Math.floor((String(derivation).match(/\$\$/g) || []).length / 2);
  const plainLines = String(derivation).split('\n').filter((l) => l.trim().length > 0).length;
  return Math.max(mathBlocks, plainLines);
}

/** 由结构信号映射 L1–L4（proxy，不是质量分）。 */
export function deriveDepthSignalLevel(s) {
  if (!s.contract_complete) return 'L1';
  const hasSubstance = s.cause_has_mechanism === true || s.derivation_blocks >= 2;
  const hasWhy = s.explains_why === true || s.actionable_hint === true;
  if (hasSubstance && hasWhy && s.transfer_hint) return 'L4';
  if (hasSubstance && hasWhy) return 'L3';
  if (s.derivation_blocks >= 1 || hasWhy || s.cause_has_mechanism === true) return 'L2';
  return 'L1';
}

/**
 * 从 provisional_truth 抽取「错因：…」片段，仅用于报告展示，不参与任何判定。
 * 没有显式「错因：」时返回 null（如实标注，不猜）。
 */
export function extractExpectedCause(truth) {
  const t = String(truth || '');
  const m = t.match(/错因[：:]\s*([\s\S]{1,180}?)(?:[。；]|$)/);
  return m ? m[1].trim() : null;
}

/**
 * 取题集声明的预期错因（**仅用于报告展示，不参与任何判定**）。
 * 优先显式 `expected_cause`；陷阱题显式标 `not_applicable_trap` 时直接返回 null，
 * 不得回退到 provisional_truth 去猜；否则回退「错因：」片段抽取，仍无则 null。
 *
 * 动机：合成题集 quality-calibration-v1.json 的多数 provisional_truth 没有
 * 「错因：」前缀（改为独立 expected_cause 字段），旧逻辑会把它们全抽成 null。
 */
export function resolveExpectedCause(caseDoc = {}) {
  const explicit = caseDoc?.expected_cause;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (caseDoc?.expected_cause_status === 'not_applicable_trap') return null;
  return extractExpectedCause(caseDoc?.provisional_truth);
}

// ── 主评估 ──────────────────────────────────────────────────────────────────

/**
 * 评估单条结果的结构代理量。
 * @param {object} result prompt-ab 报告里的单条 result（含 fields / text / mode / case_id）
 * @param {object} caseDoc 题集里对应的 case（可选 depth_target / trap / mode）
 * @returns {object} 见 MACHINE_PROXY_KEYS + 元数据；human_only 恒为 null 值对象
 */
export function evaluateQualitySignals(result, caseDoc = {}) {
  const mode = result?.mode === 'teach' ? 'teach' : 'diagnose';
  const fields = result?.fields || {};
  const rawText = String(result?.text || '');
  const cause = String(fields.cause || '');
  const derivation = String(fields.derivation || '');
  const pitfalls = String(fields.pitfalls || '');
  // narrative 排除 knowledge_point / essence 字段，避免"本质段必然含本质词"造成恒真
  const narrative = [cause, derivation, pitfalls].filter(Boolean).join('\n');
  // 字段口径（2026-11-07 真实语料探测后修订）：
  // - actionable_hint / transfer_hint 用 actionNarrative（含 essence）。这两个词表不含
  //   「本质 / 原理」等元话语词，纳入不会恒真；而「本质」段恰恰是模型写改错指令与
  //   迁移提示的主要位置（探针：8093 34 题 actionable_hint 2/34 → 6/34）。
  //   尤其 v0.5-depth 明确要求把「同类变式」写进「本质」/「常见陷阱」，
  //   若继续排除 essence，A/B 会把真实提升误读成 0。
  // - explains_why 刻意继续排除 essence：其词表含 /本质(上|是|在于)/、/原理/，
  //   而 v0.5-depth 要求模型在「本质」段写成立的依据，纳入会造恒真假指标。
  //   探针显示排除代价可控（1/34 → 纳入后 2/34）。
  // - transfer_hint 纳入前后均 0/34，说明「变式 0」是真实深度缺口，不是口径造成。
  const essence = String(fields.essence || '');
  const actionNarrative = [narrative, essence].filter(Boolean).join('\n');

  const isDiagnose = mode === 'diagnose';
  const contractComplete = isDiagnose ? Boolean(fields.hasThree) : Boolean(fields.hasCore);

  const signals = {
    contract_complete: contractComplete,
    // 诊断专属：null = 该题不适用（讲解模式），不要用 false 冒充"没问题"
    cause_has_empty_label: isDiagnose && cause
      ? (hasAny(cause, EMPTY_CAUSE_LABELS) && !hasAny(cause, MECHANISM_PATTERNS))
      : null,
    cause_has_mechanism: isDiagnose && cause ? hasAny(cause, MECHANISM_PATTERNS) : null,
    actionable_hint: actionNarrative ? hasAny(actionNarrative, ACTIONABLE_PATTERNS) : false,
    explains_why: narrative ? hasAny(narrative, EXPLAIN_WHY_PATTERNS) : false,
    derivation_blocks: isDiagnose ? 0 : countDerivationBlocks(derivation),
    pitfall_section: pitfalls.trim().length > 0,
    transfer_hint: actionNarrative ? hasAny(actionNarrative, TRANSFER_PATTERNS) : false,
    structured_ids_present: STRUCTURED_ID_PATTERN.test(rawText),
  };
  signals.depth_signal_level = deriveDepthSignalLevel(signals);

  const target = caseDoc?.depth_target;
  const depthTarget = typeof target === 'string' && /^L[1-4]$/.test(target) ? target : null;

  return {
    case_id: String(result?.case_id || ''),
    variant: String(result?.variant || ''),
    mode,
    trap: Boolean(caseDoc?.trap ?? result?.trap),
    ...signals,
    depth_target: depthTarget,
    depth_target_status: depthTarget ? 'set' : 'unspecified',
    expected_cause: resolveExpectedCause(caseDoc),
    review_required: true,
    // 人工维度恒为 null：机器绝不给本质分 / 可指导分
    human_only: Object.fromEntries(HUMAN_ONLY_DIMENSIONS.map((k) => [k, null])),
  };
}

const pct = (n, d) => (d ? Number((n / d).toFixed(4)) : null);

/** 汇总一批 signals；human_only 状态显式标为待人工盲评。 */
export function summarizeQuality(signals) {
  const list = Array.isArray(signals) ? signals : [];
  const n = list.length;
  const diag = list.filter((s) => s.mode === 'diagnose');
  const teach = list.filter((s) => s.mode === 'teach');
  const count = (key) => list.filter((s) => s[key] === true).length;
  const dist = { L1: 0, L2: 0, L3: 0, L4: 0 };
  for (const s of list) if (dist[s.depth_signal_level] !== undefined) dist[s.depth_signal_level]++;
  const blocks = teach.map((s) => s.derivation_blocks || 0);

  return {
    schema: 1,
    n,
    diagnose_n: diag.length,
    teach_n: teach.length,
    trap_n: list.filter((s) => s.trap).length,
    proxies: {
      contract_complete: { hits: count('contract_complete'), rate: pct(count('contract_complete'), n) },
      cause_has_empty_label: { hits: count('cause_has_empty_label'), rate: pct(count('cause_has_empty_label'), diag.length) },
      cause_has_mechanism: { hits: count('cause_has_mechanism'), rate: pct(count('cause_has_mechanism'), diag.length) },
      actionable_hint: { hits: count('actionable_hint'), rate: pct(count('actionable_hint'), n) },
      explains_why: { hits: count('explains_why'), rate: pct(count('explains_why'), n) },
      pitfall_section: { hits: count('pitfall_section'), rate: pct(count('pitfall_section'), n) },
      transfer_hint: { hits: count('transfer_hint'), rate: pct(count('transfer_hint'), n) },
      structured_ids_present: { hits: count('structured_ids_present'), rate: pct(count('structured_ids_present'), n) },
      derivation_blocks_mean: blocks.length ? Number((blocks.reduce((a, b) => a + b, 0) / blocks.length).toFixed(2)) : null,
      depth_signal_level_distribution: dist,
    },
    depth_target_unspecified_count: list.filter((s) => s.depth_target_status === 'unspecified').length,
    review_queue_size: list.filter((s) => s.review_required).length,
    human_only: {
      status: 'PENDING_HUMAN_BLIND_REVIEW',
      dimensions: [...HUMAN_ONLY_DIMENSIONS],
      values: null,
      toolchain: 'npm run blind:export → 2 名评分人独立填 CSV → npm run blind:score',
    },
    proxy_caveat:
      '代理量由固定词表/正则命中得出；已完成「词表检出能力」校准（见 quality-proxy-calibration.mjs），' +
      '但校准对象是**能否检出该结构信号**，不是「该结构能否预测归因质量」：命中 ≠ 质量达标，未命中 ≠ 质量差。' +
      '构造样本只验证检出下限（全 1.0 属循环论证，不构成「词表无问题」的证据）；' +
      '真实语料探测（8093 深度思考档 34 题）显示 actionable_hint 2/34 → 纳入 essence 后 6/34，' +
      '说明部分低命中来自字段口径；transfer_hint 纳入前后均 0/34，属真实深度缺口。' +
      'explains_why 刻意只检查推导/错因/陷阱正文（排除 essence 以免「本质/原理」恒真），' +
      '且词表只认显式元话语词，1/34 不得读作「模型没讲为什么」。' +
      '本质分 / 可指导分 / 偏好 / κ 仍须人工盲评，本模块不提供质量结论。',
    disclaimer:
      '本汇总只含结构代理量，代理量命中 ≠ 归因质量达标；本质分 / 可指导分 / 偏好 / κ 必须由人工盲评产生，' +
      '不得据本汇总推断 M1 认可率或 M6 盲评准确率。',
  };
}

/** 生成人工盲评待评队列（全部条目均需人工评；陷阱题与诊断题优先）。 */
export function buildReviewQueue(signals) {
  const list = Array.isArray(signals) ? signals : [];
  return list
    .filter((s) => s.review_required)
    .map((s) => ({
      case_id: s.case_id,
      variant: s.variant,
      mode: s.mode,
      trap: s.trap,
      depth_target: s.depth_target,
      priority: s.trap ? 'P0' : s.mode === 'diagnose' ? 'P1' : 'P2',
    }))
    .sort((a, b) => (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : a.case_id.localeCompare(b.case_id)));
}
