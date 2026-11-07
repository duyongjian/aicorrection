#!/usr/bin/env node
/**
 * quality-proxy-calibration.mjs — 结构代理量「词表检出能力」离线校准脚本
 *
 * ── 诚实声明（务必先读）────────────────────────────────────────────────────
 * 1. 本脚本内置的样本是【人工构造的归因文本片段】，正/负标签由造样本者按
 *    「文本里是否出现某个结构信号」直接标注，全部显式标 synthetic: true。
 *    这些标签【不是质量标注、不是人工盲评、不是真实学生错题】。
 * 2. 本脚本校准的是「词表正则能否检出它声称要检出的【结构信号】」
 *    （灵敏度 / 特异度），【不是】「代理量能否预测归因质量」。
 *    命中率高 ≠ 归因质量好；本脚本的任何数字都不得读作质量结论。
 * 3. 本脚本【不进 G1 闸门】，不参与 auto-eval.mjs / scripts/attrib-regress.mjs
 *    的 PASS / FAIL / INCOMPLETE 判定，不影响任何门禁。
 * 4. HUMAN_ONLY_DIMENSIONS（essence_score_1_5 / guide_score_1_5 /
 *    preference / cohens_kappa）恒为 null：机器绝不给 1–5 分、绝不造 κ。
 * 5. 纯离线：只读本地源码与 fixtures，只写 reports/；不联网、不启 3001、
 *    不碰生产库；计算完全确定（无随机、无网络、无时间依赖的判定逻辑）。
 *
 * 运行：
 *   node apps/api/src/tests/quality-proxy-calibration.mjs
 *   node apps/api/src/tests/quality-proxy-calibration.mjs --baseline <基线.json>
 *     （--baseline 会在 MD 报告里额外生成「校准前后灵敏度/特异度对照表」，
 *       基线文件为首次运行（旧词表）产生的报告，数字来自真实报告文件。）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evaluateQualitySignals, extractExpectedCause } from './quality-rubric.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(HERE, '../../../../reports');
const FIXTURE_PATH = path.resolve(HERE, './fixtures/quality-calibration-v1.json');
const TARGET = 0.8; // 灵敏度 / 特异度达标阈值
const DERIVATION_HIT_THRESHOLD = 2; // derivation_blocks 是计数，>=2 视为「命中多块推导」

// ── 代理量 → 词表 / 命中谓词 ────────────────────────────────────────────────
// hit(signals) 把 evaluateQualitySignals 的输出转成「是否检出该结构信号」。
// 注意：cause_has_empty_label / cause_has_mechanism 在讲解(teach)模式为 null，
// 故这两类样本一律用 diagnose 模式；derivation_blocks 在 diagnose 模式恒 0，
// 故该类样本一律用 teach 模式。此为 evaluateQualitySignals 既有口径，不改。
const PROXY_META = Object.freeze({
  cause_has_empty_label: {
    wordTable: 'EMPTY_CAUSE_LABELS（且未命中 MECHANISM_PATTERNS 才为真）',
    hit: (s) => s.cause_has_empty_label === true,
  },
  cause_has_mechanism: {
    wordTable: 'MECHANISM_PATTERNS',
    hit: (s) => s.cause_has_mechanism === true,
  },
  actionable_hint: {
    wordTable: 'ACTIONABLE_PATTERNS',
    hit: (s) => s.actionable_hint === true,
  },
  explains_why: {
    wordTable: 'EXPLAIN_WHY_PATTERNS（narrative=cause+derivation+pitfalls 口径不变）',
    hit: (s) => s.explains_why === true,
  },
  transfer_hint: {
    wordTable: 'TRANSFER_PATTERNS',
    hit: (s) => s.transfer_hint === true,
  },
  structured_ids_present: {
    wordTable: 'STRUCTURED_ID_PATTERN（看 result.text）',
    hit: (s) => s.structured_ids_present === true,
  },
  derivation_blocks: {
    wordTable: `countDerivationBlocks（计数，阈值 >=${DERIVATION_HIT_THRESHOLD}，非词表）`,
    hit: (s) => (s.derivation_blocks || 0) >= DERIVATION_HIT_THRESHOLD,
  },
});

// ── 样本工厂 ────────────────────────────────────────────────────────────────
// 每条样本都显式带 synthetic: true；result 结构与任务约定一致：
// { mode, case_id, text, fields: { cause, derivation, pitfalls, hasThree, hasCore } }
const S = (id, label, proxy, parts = {}) => {
  const isTeach = parts.mode === 'teach';
  return {
    id,
    label,
    proxy,
    synthetic: true,
    result: {
      mode: isTeach ? 'teach' : 'diagnose',
      case_id: id,
      text: parts.text || '',
      fields: {
        cause: parts.cause || '',
        derivation: parts.derivation || '',
        pitfalls: parts.pitfalls || '',
        hasThree: !isTeach,
        hasCore: isTeach,
      },
    },
  };
};

// ── 84 条人工构造样本（7 类 × 6 正 + 6 负）─────────────────────────────────
// 设计原则：
//  · 正样本 = 人一眼能判断「含该结构信号」的常见归因表述，其中若干是旧词表
//    未覆盖的同义写法（用于暴露「词表过窄 → 漏检」）。
//  · 负样本 = 人一眼能判断「不含该结构信号」的文本，其中含专门哨兵
//    （如「概念混淆」检验 empty_label 的「命中空标签 且 未命中机制」口径；
//     「valid/width/considered」检验 structured_id 不能放宽到裸 id 恒真）。
//  · 每条样本只按其 proxy 对应的判定计命中，其他代理量的值不参与该样本评分。
const SAMPLES = Object.freeze([
  // ① cause_has_empty_label（diagnose，信号在 cause；正=纯空标签且无机制词）
  S('el-p1', 'positive', 'cause_has_empty_label', { cause: '粗心' }),
  S('el-p2', 'positive', 'cause_has_empty_label', { cause: '审题不仔细' }),
  S('el-p3', 'positive', 'cause_has_empty_label', { cause: '基础不扎实' }),
  S('el-p4', 'positive', 'cause_has_empty_label', { cause: '对概念不清' }), // 旧表行尾锚 → 漏
  S('el-p5', 'positive', 'cause_has_empty_label', { cause: '疏忽大意' }), // 旧表无「疏忽/大意」→ 漏
  S('el-p6', 'positive', 'cause_has_empty_label', { cause: '知识掌握得不扎实' }), // 旧表无 → 漏
  S('el-n1', 'negative', 'cause_has_empty_label', { cause: "误把 uv'=u'v' 当成乘积求导法则" }),
  S('el-n2', 'negative', 'cause_has_empty_label', { cause: '因为漏掉换元产生的系数 1/2' }),
  S('el-n3', 'negative', 'cause_has_empty_label', { cause: '概念混淆' }), // 口径哨兵：空标签词+机制词→应 false
  S('el-n4', 'negative', 'cause_has_empty_label', { cause: '把重力沿斜面分量与垂直分量混淆' }),
  S('el-n5', 'negative', 'cause_has_empty_label', { cause: '未识别句首否定副词触发的部分倒装' }),
  S('el-n6', 'negative', 'cause_has_empty_label', { cause: '把角频率与周期的关系弄反' }),

  // ② cause_has_mechanism（diagnose，信号在 cause；正=写出「怎么错的」）
  S('me-p1', 'positive', 'cause_has_mechanism', { cause: '因为把减号记成了加号' }),
  S('me-p2', 'positive', 'cause_has_mechanism', { cause: "漏掉了 uv' 项" }),
  S('me-p3', 'positive', 'cause_has_mechanism', { cause: '误将串联电容直接相加' }),
  S('me-p4', 'positive', 'cause_has_mechanism', { cause: '把有序样本当无序组合计数' }), // 旧表无「把…当」→ 漏
  S('me-p5', 'positive', 'cause_has_mechanism', { cause: '把 sinθ 与 cosθ 记反了' }), // 旧表无「记反」→ 漏
  S('me-p6', 'positive', 'cause_has_mechanism', { cause: '套用了并联公式，符号弄反' }), // 旧表无 → 漏
  S('me-n1', 'negative', 'cause_has_mechanism', { cause: '粗心' }),
  S('me-n2', 'negative', 'cause_has_mechanism', { cause: '基础不牢' }),
  S('me-n3', 'negative', 'cause_has_mechanism', { cause: '计算失误' }),
  S('me-n4', 'negative', 'cause_has_mechanism', { cause: '不熟练' }),
  S('me-n5', 'negative', 'cause_has_mechanism', { cause: '概念不清' }),
  S('me-n6', 'negative', 'cause_has_mechanism', { cause: '知识掌握得不扎实' }),

  // ③ actionable_hint（diagnose，信号在 cause → narrative；正=可操作改错指令）
  S('ac-p1', 'positive', 'actionable_hint', { cause: '应该展开到三阶再代入' }),
  S('ac-p2', 'positive', 'actionable_hint', { cause: '改为 ad-bc' }),
  S('ac-p3', 'positive', 'actionable_hint', { cause: '须先通分再约分' }),
  S('ac-p4', 'positive', 'actionable_hint', { cause: '应当保留换元产生的 1/2 系数' }), // 旧表无「保留」→ 漏
  S('ac-p5', 'positive', 'actionable_hint', { cause: '用泰勒展开代替一阶等价代换' }), // 旧表无 → 漏
  S('ac-p6', 'positive', 'actionable_hint', { cause: '把 x dx 换成 1/2 du' }), // 旧表无「换成」→ 漏
  S('ac-n1', 'negative', 'actionable_hint', { cause: '错因是粗心，知识点是等价无穷小' }),
  S('ac-n2', 'negative', 'actionable_hint', { cause: '正确答案为 1/6' }), // 「正确答案」不得被误当「正确做法」
  S('ac-n3', 'negative', 'actionable_hint', { cause: '极限值为 -1/6，推导见下' }),
  S('ac-n4', 'negative', 'actionable_hint', { cause: '学生把减号记成了加号，结果为 10' }),
  S('ac-n5', 'negative', 'actionable_hint', { cause: '本题考查乘积求导法则' }),
  S('ac-n6', 'negative', 'actionable_hint', { cause: '错因在于主部在加减时抵消' }),

  // ④ explains_why（diagnose，信号在 cause → narrative；正=解释「为什么」）
  S('wh-p1', 'positive', 'explains_why', { cause: '为什么加减运算中不能直接代换等价无穷小' }),
  S('wh-p2', 'positive', 'explains_why', { cause: '其原理在于等价无穷小只适用于乘除' }),
  S('wh-p3', 'positive', 'explains_why', { cause: '本质上是因为把 ω 与 T 的关系弄反' }),
  S('wh-p4', 'positive', 'explains_why', { cause: '其理由是变化率与当前值成正比' }), // 旧表无「理由」→ 漏
  S('wh-p5', 'positive', 'explains_why', { cause: '关键在于分母的阶数要展开到四阶' }), // 旧表无「关键在于」→ 漏
  S('wh-p6', 'positive', 'explains_why', { cause: '可见只展开到二阶会得到 0/0 的错误结论' }), // 旧表无「可见」→ 漏
  S('wh-n1', 'negative', 'explains_why', { cause: '错因：粗心。知识点：等价无穷小。' }),
  S('wh-n2', 'negative', 'explains_why', { cause: '正确答案为 1/6，计算过程略。' }),
  S('wh-n3', 'negative', 'explains_why', { cause: "f'(x)=2x e^x + x^2 e^x" }),
  S('wh-n4', 'negative', 'explains_why', { cause: '先通分，再约分，得到 -1/6。' }),
  S('wh-n5', 'negative', 'explains_why', { cause: '学生把减号记成了加号，结果为 10。' }),
  S('wh-n6', 'negative', 'explains_why', { cause: '本题考查二阶行列式的定义。' }),

  // ⑤ transfer_hint（diagnose，信号在 cause → narrative；正=变式/迁移/举一反三）
  S('tr-p1', 'positive', 'transfer_hint', { cause: '遇到同类题也要先判阶数' }),
  S('tr-p2', 'positive', 'transfer_hint', { cause: '由此可推广到更高阶的泰勒展开' }),
  S('tr-p3', 'positive', 'transfer_hint', { cause: '换个函数也要先检查定义域' }),
  S('tr-p4', 'positive', 'transfer_hint', { cause: '以后遇到类似积分也可套用同一换元' }), // 旧表无「类似积分」→ 漏
  S('tr-p5', 'positive', 'transfer_hint', { cause: '凡是含常数项的递推都可这样平移构造' }), // 旧表无「凡是」→ 漏
  S('tr-p6', 'positive', 'transfer_hint', { cause: '同理可解所有 a(n+1)=p a(n)+q 型递推' }), // 旧表无「同理」→ 漏
  S('tr-n1', 'negative', 'transfer_hint', { cause: '错因是粗心，应改为 ad-bc。' }),
  S('tr-n2', 'negative', 'transfer_hint', { cause: '本题答案为 -1/6。' }),
  S('tr-n3', 'negative', 'transfer_hint', { cause: '展开到三阶后主部保留，得到极限。' }),
  S('tr-n4', 'negative', 'transfer_hint', { cause: '先令 u=1+x^2 再凑微分。' }),
  S('tr-n5', 'negative', 'transfer_hint', { cause: '为什么？因为主部抵消。' }),
  S('tr-n6', 'negative', 'transfer_hint', { cause: '公式记反了，须先通分。' }),

  // ⑥ structured_ids_present（信号在 result.text；正=含结构化 ID 字段）
  S('id-p1', 'positive', 'structured_ids_present', { text: '{"kq_id":"math.limit.taylor","cause_id":"equiv_sub_in_sum"}' }),
  S('id-p2', 'positive', 'structured_ids_present', { text: '知识点ID：KP-1024，错因ID：CE-33' }),
  S('id-p3', 'positive', 'structured_ids_present', { text: 'knowledge_point_id = 77' }),
  S('id-p4', 'positive', 'structured_ids_present', { text: '{"kqId":"math.limit.taylor","causeId":"equiv_sub"}' }), // camelCase → 旧漏
  S('id-p5', 'positive', 'structured_ids_present', { text: '{"concept_id":"derivative.product","error_id":"uv_missing"}' }), // 旧漏
  S('id-p6', 'positive', 'structured_ids_present', { text: '错因编号：CE-9；知识点编号：KP-3' }), // 旧表只认 ID → 漏
  S('id-n1', 'negative', 'structured_ids_present', { text: '错因：粗心\n知识点：等价无穷小\n本质：需展开到足够阶' }),
  S('id-n2', 'negative', 'structured_ids_present', { text: '正确答案为 2，推导见下。' }),
  S('id-n3', 'negative', 'structured_ids_present', { text: '{"valid": true, "guide": "review"}' }), // 恒真哨兵：裸 id 不得命中
  S('id-n4', 'negative', 'structured_ids_present', { text: 'The student considered the width.' }), // 恒真哨兵
  S('id-n5', 'negative', 'structured_ids_present', { text: '知识点：导数的乘积法则；错因：漏项。' }),
  S('id-n6', 'negative', 'structured_ids_present', { text: 'kq 文本标签：等价无穷小（暂未分配 ID 体系）' }),

  // ⑦ derivation_blocks（teach，内容在 derivation；正=多块推导 >=2，负=0/1 块）
  S('db-p1', 'positive', 'derivation_blocks', { mode: 'teach', derivation: '$$A$$\n$$B$$' }),
  S('db-p2', 'positive', 'derivation_blocks', { mode: 'teach', derivation: '第一行\n第二行\n第三行' }),
  S('db-p3', 'positive', 'derivation_blocks', { mode: 'teach', derivation: "$$f'(x)=2x e^x$$\n$$f'(x)=2x e^x+x^2 e^x$$" }),
  S('db-p4', 'positive', 'derivation_blocks', { mode: 'teach', derivation: '步骤一：展开\n步骤二：代入\n步骤三：化简' }),
  S('db-p5', 'positive', 'derivation_blocks', { mode: 'teach', derivation: '$$∫u dv=uv-∫v du$$\n取 u=x\n得 (x-1)e^x' }),
  S('db-p6', 'positive', 'derivation_blocks', { mode: 'teach', derivation: '行1\n行2' }),
  S('db-n1', 'negative', 'derivation_blocks', { mode: 'teach', derivation: '' }),
  S('db-n2', 'negative', 'derivation_blocks', { mode: 'teach', derivation: '$$A$$' }),
  S('db-n3', 'negative', 'derivation_blocks', { mode: 'teach', derivation: '仅一行推导' }),
  S('db-n4', 'negative', 'derivation_blocks', { mode: 'teach', derivation: '$$A$$\n' }),
  S('db-n5', 'negative', 'derivation_blocks', { mode: 'teach', derivation: '   ' }),
  S('db-n6', 'negative', 'derivation_blocks', { mode: 'teach', derivation: '  \n  ' }),
]);

// ── 工具 ────────────────────────────────────────────────────────────────────
function snippetOf(result) {
  const parts = [result?.fields?.cause, result?.fields?.derivation, result?.fields?.pitfalls, result?.text];
  const s = parts.filter(Boolean).join(' | ').replace(/\s+/g, ' ').trim();
  return s.length > 96 ? s.slice(0, 96) + '…' : s || '(空文本)';
}
const r4 = (x) => (x === null || x === undefined ? null : Number(x.toFixed(4)));
const pctStr = (x) => (x === null ? '—' : (x * 100).toFixed(1) + '%');

// ── 主评估：逐样本调 evaluateQualitySignals ─────────────────────────────────
const perSample = [];
for (const smp of SAMPLES) {
  const signals = evaluateQualitySignals(smp.result, {});
  const hit = PROXY_META[smp.proxy].hit(signals);
  const expectedHit = smp.label === 'positive';
  const outcome = expectedHit ? (hit ? 'TP' : 'FN') : hit ? 'FP' : 'TN';
  perSample.push({
    id: smp.id,
    proxy: smp.proxy,
    label: smp.label,
    synthetic: true,
    signal_value: signals[smp.proxy],
    hit,
    expected_hit: expectedHit,
    outcome, // TP / FN（漏检）/ TN / FP（误检）
    snippet: snippetOf(smp.result),
  });
}

const perProxy = {};
for (const proxy of Object.keys(PROXY_META)) {
  const rows = perSample.filter((r) => r.proxy === proxy);
  const P = rows.filter((r) => r.label === 'positive');
  const N = rows.filter((r) => r.label === 'negative');
  const TP = P.filter((r) => r.hit).length;
  const FN = P.length - TP;
  const TN = N.filter((r) => !r.hit).length;
  const FP = N.length - TN;
  const sensitivity = P.length ? TP / P.length : null;
  const specificity = N.length ? TN / N.length : null;
  perProxy[proxy] = {
    word_table: PROXY_META[proxy].wordTable,
    n_positive: P.length,
    n_negative: N.length,
    TP, FN, TN, FP,
    sensitivity: r4(sensitivity),
    specificity: r4(specificity),
    meets_target: sensitivity >= TARGET && specificity >= TARGET,
  };
}
const falseNegatives = perSample.filter((r) => r.outcome === 'FN');
const falsePositives = perSample.filter((r) => r.outcome === 'FP');
const allMeet = Object.values(perProxy).every((p) => p.meets_target);

// ── 30 题题集 expected_cause 校验（C 的真实缺口验证）───────────────────────
// 对每题构造最小 result，跑 evaluateQualitySignals；同时模拟「旧口径」
// = 仅 extractExpectedCause(provisional_truth)，用于对照修复效果。
function runExpectedCauseFixtureCheck() {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const perCase = [];
  let currentNonNull = 0;
  let legacyNonNull = 0;
  let trapTotal = 0;
  let trapCurrentNull = 0;
  for (const c of fixture.cases) {
    const isTeach = c.mode === 'teach';
    const minResult = {
      mode: c.mode,
      case_id: c.id,
      text: '',
      fields: { cause: '', derivation: '', pitfalls: '', hasThree: !isTeach, hasCore: isTeach },
    };
    const legacy = extractExpectedCause(c.provisional_truth); // 旧：只从 provisional_truth 抓「错因：」
    const current = evaluateQualitySignals(minResult, c).expected_cause; // 新：显式字段优先 / trap 直接 null / 回退
    const curOk = typeof current === 'string' && current.trim() !== '';
    const legacyOk = typeof legacy === 'string' && legacy.trim() !== '';
    if (curOk) currentNonNull++;
    if (legacyOk) legacyNonNull++;
    const isTrap = c.trap === true || c.expected_cause_status === 'not_applicable_trap';
    if (isTrap) {
      trapTotal++;
      if (!curOk) trapCurrentNull++;
    }
    perCase.push({ id: c.id, mode: c.mode, trap: isTrap, legacy_null: !legacyOk, current_null: !curOk });
  }
  return {
    fixture: 'apps/api/src/tests/fixtures/quality-calibration-v1.json',
    n: fixture.cases.length,
    current_non_null: currentNonNull, // 修复后：expected_cause 非 null 条数
    legacy_non_null: legacyNonNull, // 旧口径（仅正则抓「错因：」）非 null 条数
    trap_total: trapTotal, // 陷阱题总数
    trap_current_null: trapCurrentNull, // 陷阱题仍为 null 的条数
    per_case: perCase,
  };
}
const expectedCauseFixtureCheck = runExpectedCauseFixtureCheck();

// ── --baseline 对照 ─────────────────────────────────────────────────────────
function loadComparison() {
  const idx = process.argv.indexOf('--baseline');
  if (idx === -1 || !process.argv[idx + 1]) return null;
  const file = path.resolve(process.cwd(), process.argv[idx + 1]);
  if (!existsSync(file)) {
    console.warn(`[warn] --baseline 文件不存在，跳过对照表：${file}`);
    return null;
  }
  const base = JSON.parse(readFileSync(file, 'utf8'));
  const before = base.per_proxy || {};
  const rows = Object.keys(PROXY_META).map((proxy) => {
    const b = before[proxy] || {};
    const a = perProxy[proxy];
    const bSens = b.sensitivity ?? null;
    const bSpec = b.specificity ?? null;
    return {
      proxy,
      before_sensitivity: bSens,
      after_sensitivity: a.sensitivity,
      delta_sensitivity: bSens === null || a.sensitivity === null ? null : r4(a.sensitivity - bSens),
      before_specificity: bSpec,
      after_specificity: a.specificity,
      delta_specificity: bSpec === null || a.specificity === null ? null : r4(a.specificity - bSpec),
      after_meets_target: a.meets_target,
    };
  });
  return { baseline_file: path.relative(process.cwd(), file), rows };
}
const baselineComparison = loadComparison();

// ── 组装报告 ────────────────────────────────────────────────────────────────
const generatedAt = new Date().toISOString();
const report = {
  meta: {
    generated_at: generatedAt,
    script: 'apps/api/src/tests/quality-proxy-calibration.mjs',
    purpose: '校准「词表能否检出它声称要检出的结构信号」，非质量结论',
    synthetic: true,
    sample_count: SAMPLES.length,
    per_proxy_positive: 6,
    per_proxy_negative: 6,
    target: TARGET,
    derivation_hit_threshold: DERIVATION_HIT_THRESHOLD,
    disclaimer:
      '构造样本只校准词表检出能力，不是质量标注、不是人工盲评、不进 G1。' +
      '灵敏度/特异度衡量的是正则命中能力，不代表代理量能预测归因质量。' +
      'HUMAN_ONLY_DIMENSIONS 恒为 null，机器绝不给 1–5 分、绝不造 κ；代理量不参与 auto-eval / attrib-regress 门禁。',
  },
  per_proxy: perProxy,
  overall: {
    all_meet_target: allMeet,
    proxies_below_target: Object.entries(perProxy)
      .filter(([, p]) => !p.meets_target)
      .map(([k]) => k),
    false_negative_count: falseNegatives.length,
    false_positive_count: falsePositives.length,
  },
  false_negatives: falseNegatives, // 漏检明细（含 id 与文本片段）
  false_positives: falsePositives, // 误检明细
  per_sample: perSample,
  baseline_comparison: baselineComparison,
  expected_cause_fixture_check: expectedCauseFixtureCheck,
};

// ── 写报告（reports/ 已 gitignore）─────────────────────────────────────────
if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
const ts = generatedAt.replace(/[:.]/g, '-');
const jsonPath = path.join(REPORTS_DIR, `quality-proxy-calibration-${ts}.json`);
const mdPath = path.join(REPORTS_DIR, `quality-proxy-calibration-${ts}.md`);
writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

const mdLines = [];
mdLines.push('# 结构代理量词表校准报告');
mdLines.push('');
mdLines.push(`- 生成时间：${generatedAt}`);
mdLines.push(`- 样本：**${SAMPLES.length} 条人工构造片段**（7 类代理量 × 6 正 + 6 负，全部 \`synthetic: true\`）`);
mdLines.push(`- 达标阈值：灵敏度 ≥ ${TARGET} 且 特异度 ≥ ${TARGET}`);
mdLines.push(`- \`derivation_blocks\` 为计数，命中阈值取 \`>= ${DERIVATION_HIT_THRESHOLD}\`（与词表类分开说明）`);
mdLines.push('');
mdLines.push('> **诚实边界**：本表校准的是「词表能否检出它声称要检出的**结构信号**」，**不是**「代理量能否预测归因质量」。');
mdLines.push('> 构造样本标签是人造的，不是质量标注、不是人工盲评、不进 G1。命中 ≠ 质量达标。');
mdLines.push('> `HUMAN_ONLY_DIMENSIONS`（本质分/可指导分/偏好/κ）恒为 null；代理量不参与 auto-eval / attrib-regress 门禁。');
mdLines.push('');
mdLines.push('## 1. 各代理量灵敏度 / 特异度（本次运行）');
mdLines.push('');
mdLines.push('| 代理量 | 词表 | 正/负 | TP | FN | TN | FP | 灵敏度 | 特异度 | 达标 |');
mdLines.push('|---|---|---|---|---|---|---|---|---|---|');
for (const [proxy, p] of Object.entries(perProxy)) {
  mdLines.push(
    `| ${proxy} | ${p.word_table} | ${p.n_positive}/${p.n_negative} | ${p.TP} | ${p.FN} | ${p.TN} | ${p.FP} | ` +
    `${pctStr(p.sensitivity)} | ${pctStr(p.specificity)} | ${p.meets_target ? '✅' : '❌'} |`,
  );
}
mdLines.push('');
mdLines.push(`- 漏检（FN）合计 **${falseNegatives.length}** 条；误检（FP）合计 **${falsePositives.length}** 条。`);
mdLines.push(`- 全部达标：**${allMeet ? '是' : '否'}**；未达标代理量：${report.overall.proxies_below_target.length ? report.overall.proxies_below_target.join('、') : '无'}。`);
mdLines.push('');

if (baselineComparison) {
  mdLines.push('## 2. 校准前后对照表');
  mdLines.push('');
  mdLines.push(`基线来源：\`${baselineComparison.baseline_file}\`（首次运行 / 修订前词表产生的报告，数字来自该报告文件）。`);
  mdLines.push('');
  mdLines.push('| 代理量 | 校准前灵敏度 | 校准后灵敏度 | Δ灵敏度 | 校准前特异度 | 校准后特异度 | Δ特异度 | 校准后达标 |');
  mdLines.push('|---|---|---|---|---|---|---|---|');
  for (const r of baselineComparison.rows) {
    const d = (x) => (x === null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + 'pp');
    mdLines.push(
      `| ${r.proxy} | ${pctStr(r.before_sensitivity)} | ${pctStr(r.after_sensitivity)} | ${d(r.delta_sensitivity)} | ` +
      `${pctStr(r.before_specificity)} | ${pctStr(r.after_specificity)} | ${d(r.delta_specificity)} | ${r.after_meets_target ? '✅' : '❌'} |`,
    );
  }
  mdLines.push('');
}

const secDetail = baselineComparison ? '3' : '2';
mdLines.push(`## ${secDetail}. 逐样本漏检 / 误检明细`);
mdLines.push('');
if (falseNegatives.length === 0) {
  mdLines.push('漏检：**无**。');
} else {
  mdLines.push(`### 漏检（正样本未被检出，共 ${falseNegatives.length} 条）`);
  mdLines.push('');
  mdLines.push('| id | 代理量 | signal 实际值 | 文本片段 |');
  mdLines.push('|---|---|---|---|');
  for (const r of falseNegatives) {
    mdLines.push(`| ${r.id} | ${r.proxy} | \`${JSON.stringify(r.signal_value)}\` | ${escapeMd(r.snippet)} |`);
  }
  mdLines.push('');
}
if (falsePositives.length === 0) {
  mdLines.push('误检：**无**。');
} else {
  mdLines.push(`### 误检（负样本被误命中，共 ${falsePositives.length} 条）`);
  mdLines.push('');
  mdLines.push('| id | 代理量 | signal 实际值 | 文本片段 |');
  mdLines.push('|---|---|---|---|');
  for (const r of falsePositives) {
    mdLines.push(`| ${r.id} | ${r.proxy} | \`${JSON.stringify(r.signal_value)}\` | ${escapeMd(r.snippet)} |`);
  }
}
mdLines.push('');

const secFixture = baselineComparison ? '4' : '3';
const fc = expectedCauseFixtureCheck;
mdLines.push(`## ${secFixture}. 30 题题集 expected_cause 校验（C 的修复验证）`);
mdLines.push('');
mdLines.push(`- 题集：\`${fc.fixture}\`（${fc.n} 题）`);
mdLines.push(`- **修复后** \`expected_cause\` 非 null 条数：**${fc.current_non_null}**`);
mdLines.push(`- 旧口径（仅 \`extractExpectedCause(provisional_truth)\` 正则抓「错因：」）非 null 条数：**${fc.legacy_non_null}**（对照）`);
mdLines.push(`- 陷阱题总数：**${fc.trap_total}**；修复后仍为 null 的条数：**${fc.trap_current_null}**（应为全部 null，trap 不得回退猜测）`);
mdLines.push('');

const secHonest = baselineComparison ? '5' : '4';
mdLines.push(`## ${secHonest}. 诚实边界与残留说明`);
mdLines.push('');
mdLines.push('- 本报告所有数字只针对**人工构造样本**上的词表检出能力，不能外推到真实模型输出或归因质量。');
mdLines.push('- 达标（≥0.8）仅表示词表在本样本集上检出了它声称要检出的结构信号；不构成「代理量有效」的证据。');
mdLines.push('- **循环论证局限**：正样本是参照「词表应覆盖的同义表达」人工构造、修订词表时又据漏检明细定向补充，因此「全 1.0」几乎是设计使然，只能证明词表在本样本上无漏检/无误检，**不能证明词表在真实模型输出上无问题**。真正有效的外部验证须用真实语料（8093 深度思考档 / A-B 合并件）由统一评分流程完成，本脚本不提供该结论。');
mdLines.push('- 特意未放宽到恒真：`structured_ids_present` 负样本含 `valid`/`guide`/`considered`/`width` 等含 id 子串的普通词，`cause_has_empty_label` 负样本「概念混淆」是「空标签词+机制词→应 false」的口径哨兵，均保持正确拒绝（特异度 100%）。');
mdLines.push('- `quality-rubric.mjs` 的 `proxy_caveat` 仍如实声明「代理量对质量的预测未经人工盲评校准」，本脚本未改该口径。');
mdLines.push('');

function escapeMd(s) {
  return String(s).replace(/\|/g, '\\|').replace(/`/g, "'");
}

writeFileSync(mdPath, mdLines.join('\n'), 'utf8');

// ── stdout 摘要 ─────────────────────────────────────────────────────────────
console.log('=== 结构代理量词表校准（词表检出能力，非质量结论）===');
console.log(`样本 ${SAMPLES.length} 条（7 类 × 6 正 + 6 负，synthetic:true）  阈值 灵敏度/特异度 ≥ ${TARGET}`);
console.log('');
console.log('代理量'.padEnd(26) + '灵敏度'.padEnd(10) + '特异度'.padEnd(10) + 'TP/FN/TN/FP'.padEnd(16) + '达标');
console.log('-'.repeat(74));
for (const [proxy, p] of Object.entries(perProxy)) {
  console.log(
    proxy.padEnd(26) +
    pctStr(p.sensitivity).padEnd(10) +
    pctStr(p.specificity).padEnd(10) +
    `${p.TP}/${p.FN}/${p.TN}/${p.FP}`.padEnd(16) +
    (p.meets_target ? '✅' : '❌'),
  );
}
console.log('-'.repeat(74));
console.log(`全部达标: ${allMeet ? '是' : '否'}  |  漏检(FN): ${falseNegatives.length}  |  误检(FP): ${falsePositives.length}`);
if (report.overall.proxies_below_target.length) {
  console.log(`未达标代理量: ${report.overall.proxies_below_target.join('、')}`);
}
console.log('');
if (falseNegatives.length) {
  console.log('— 漏检明细 —');
  for (const r of falseNegatives) console.log(`  [${r.id}] ${r.proxy} | ${r.snippet}`);
}
if (falsePositives.length) {
  console.log('— 误检明细 —');
  for (const r of falsePositives) console.log(`  [${r.id}] ${r.proxy} | ${r.snippet}`);
}
console.log('');
console.log('=== 30 题题集 expected_cause 校验（C 修复验证）===');
console.log(`  题数: ${fc.n}  修复后非 null: ${fc.current_non_null}  旧口径非 null(对照): ${fc.legacy_non_null}`);
console.log(`  陷阱题: ${fc.trap_total}  修复后仍为 null: ${fc.trap_current_null}（应=${fc.trap_total}）`);
console.log('');
if (baselineComparison) {
  console.log(`=== 校准前后对照（基线: ${baselineComparison.baseline_file}）===`);
  for (const r of baselineComparison.rows) {
    console.log(
      `  ${r.proxy.padEnd(26)} 灵敏度 ${pctStr(r.before_sensitivity)} → ${pctStr(r.after_sensitivity)}  特异度 ${pctStr(r.before_specificity)} → ${pctStr(r.after_specificity)}`,
    );
  }
  console.log('');
}
console.log(`报告 JSON: ${path.relative(process.cwd(), jsonPath)}`);
console.log(`报告 MD  : ${path.relative(process.cwd(), mdPath)}`);
