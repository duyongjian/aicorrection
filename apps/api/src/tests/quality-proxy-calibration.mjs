#!/usr/bin/env node
/**
 * quality-proxy-calibration.mjs — 结构代理量「词表检出能力」校准（只读、离线、可重跑）
 *
 * ── 口径纪律（DSR 诚实标定，不可放宽）──────────────────────────────────────
 * 1. 本脚本校准的是「词表/正则能否检出它声称要检出的**结构信号**」，
 *    **不是**「代理量能否预测归因质量」。正/负样本是造题者构造的文本片段，
 *    标签是「这句话里有没有该结构」，不是质量打分、不是人工盲评。
 * 2. 所有样本 `synthetic: true`。结果**禁止**用于 G1 闸门判定、禁止推断
 *    M1 认可率 / M6 盲评准确率、禁止写进对外材料当作真实样本。
 * 3. `HUMAN_ONLY_DIMENSIONS` 仍恒为 null；本脚本不给任何 1–5 分，
 *    不参与 auto-eval / attrib-regress 的 PASS/FAIL 判定。
 * 4. 灵敏度低 = 词表太窄（漏检）；特异度低 = 词表太宽（误检）。
 *    两者都不能读作「模型归因差」或「模型归因好」。
 * 5. ⚠️ **构造样本是照着词表写的，全 1.0 属循环论证，只验证「检出下限」，
 *    不构成「词表无问题」的证据**。真正的漏检证据来自下方「真实语料探测」：
 *    用 8093 深度思考档 34 题真实输出跑同一批代理量，并模拟修复前口径做对照。
 *
 * 用法：node apps/api/src/tests/quality-proxy-calibration.mjs
 * 产物：reports/quality-proxy-calibration-<ts>.json / .md（reports/ 已 gitignore）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateQualitySignals, HUMAN_ONLY_DIMENSIONS } from './quality-rubric.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const REPORT_DIR = path.join(REPO_ROOT, 'reports');

/** 布尔型代理量：positive 期望 true，negative 期望 false。 */
const BOOLEAN_PROXIES = [
  'cause_has_empty_label',
  'cause_has_mechanism',
  'actionable_hint',
  'explains_why',
  'transfer_hint',
  'structured_ids_present',
];
/** 计数型代理量：positive 期望 >=2 块，negative 期望 <=1 块。 */
const COUNT_PROXIES = ['derivation_blocks'];
const ALL_PROXIES = [...BOOLEAN_PROXIES, ...COUNT_PROXIES];
const THRESHOLD = 0.8;

function makeResult(mode, field, text) {
  const fields = { hasThree: true, hasCore: true, cause: '', derivation: '', pitfalls: '' };
  if (field === 'text') {
    // structured_ids_present 检测的是 result.text（整段原文），不是某个字段
    return { mode, case_id: 'calib', variant: 'calibration', text, fields };
  }
  fields[field] = text;
  return {
    mode,
    case_id: 'calib',
    variant: 'calibration',
    text: [fields.cause, fields.derivation, fields.pitfalls].filter(Boolean).join('\n'),
    fields,
  };
}

/** 全部样本显式标注 synthetic；一条样本只针对一个 proxy 计分，不对其他 proxy 下结论。 */
const SAMPLES = [];
function addSet(proxy, mode, field, positives, negatives) {
  for (const [i, text] of positives.entries()) {
    SAMPLES.push({
      id: `${proxy}-P${i + 1}`, proxy, label: 'positive', synthetic: true, raw: text,
      result: makeResult(mode, field, text),
    });
  }
  for (const [i, text] of negatives.entries()) {
    SAMPLES.push({
      id: `${proxy}-N${i + 1}`, proxy, label: 'negative', synthetic: true, raw: text,
      result: makeResult(mode, field, text),
    });
  }
}

// ① 空标签错因：命中空泛词 **且** 不含任何因果机制词
//    负样本里特意放一条「粗心 + 机制」，防止把判据退化成只看空泛词
addSet('cause_has_empty_label', 'diagnose', 'cause',
  ['粗心', '基础不牢', '概念不清', '计算错误', '不熟练', '审题不仔细'],
  [
    '因为把乘积求导误记为 $(uv)\'=u\'v\'$，漏掉 $uv\'$ 项',
    '粗心导致漏掉了换元系数 $1/2$',
    '混淆了 $\\sin x$ 与 $\\tan x$ 的泰勒展开阶数',
    '忽略了 $x<0$ 时 $|x|=-x$ 的分支',
    '误将非齐次递推当作等比数列',
    '未考虑分母为零的情形',
  ]);

// ② 因果机制：错因里写了「怎么错的」而非纯标签
addSet('cause_has_mechanism', 'diagnose', 'cause',
  [
    '因为等价无穷小在相减时丢失了三阶主部',
    '由于把 $a_{n+1}=3a_n+2$ 误判为齐次等比',
    '漏掉换元产生的系数 $1/2$',
    '混淆了极大值与极小值的判定条件',
    '忽略了 $x<0$ 时 $|x|=-x$',
    '未考虑分母为零的情形',
  ],
  [
    '该结果与标准答案不符',
    '答案为 $2$，学生写成了 $3$',
    '第二步的符号与结论不一致',
    '用到的法则是乘积求导',
    '涉及知识点为泰勒展开',
    '此题属于中档难度',
  ]);

// ③ 可操作改错指令：下次遇到同类题该先做什么 / 改成什么
addSet('actionable_hint', 'diagnose', 'cause',
  [
    '应先用泰勒展开到三阶再代入',
    '须把 $x\\,dx$ 改为 $\\frac{1}{2}du$',
    '改为构造 $a_n+1$ 的等比数列',
    '正确做法是先求驻点再比较端点',
    '通分后再合并同类项',
    '令 $u=1+x^{2}$，则 $du=2x\\,dx$',
  ],
  [
    '这个结果不对',
    '乘积求导法则要求保留两项',
    '本题考察等价无穷小的适用条件',
    '正确答案为 $1/2$',
    '推导过程共三步',
    '学生没有写单位',
  ]);

// ④ 解释「为什么」：只在 cause/derivation/pitfalls 拼成的 narrative 里查
addSet('explains_why', 'diagnose', 'cause',
  [
    '为什么会错在于等价无穷小相减时精度不够',
    '其原理是泰勒展开需保留到第一个非零阶',
    '本质上是忽略了高阶项',
    '原因在于分母为零时该变形不成立',
    '这意味着区间端点需要单独检验',
    '根据链式法则可知需再乘以内层导数',
  ],
  [
    '答案为 $1/2$',
    '乘积求导有两类项',
    '先展开再代入',
    '令 $u=1+x^{2}$',
    '正确做法是先求驻点',
    '该题为中等难度',
  ]);

// ⑤ 迁移 / 变式（L4 结构代理）
addSet('transfer_hint', 'diagnose', 'cause',
  [
    '推广到更高阶的相减情形同样适用',
    '同类题都可以先做平移构造',
    '换个函数时判据不变',
    '由此可推广到一般的一阶线性递推',
    '可复用到所有含常数项的递推',
    '变式：把 $+2$ 换成任意常数',
  ],
  [
    '答案为 $1/2$',
    '乘积求导保留两项',
    '先展开再代入',
    '正确做法是先求驻点',
    '学生漏写单位',
    '本题难度中等',
  ]);

// ⑥ 结构化 ID（KPI §6.3.1）；检测 result.text 原文
addSet('structured_ids_present', 'diagnose', 'text',
  [
    '"kq_id": "MATH.DERIV.PRODUCT"',
    '"cause_id": "CAUSE-012"',
    'kq_ids: ["K-1", "K-2"]',
    'knowledge_point_id=KP_003',
    '错因ID：C-17',
    '知识点ID：K-22',
  ],
  [
    '错因：漏掉一项',
    '知识点：乘积求导',
    '本质：需保留两项',
    '正确答案：$1/2$',
    '推导完毕',
    '无结构化字段',
  ]);

// ⑦ 推导块数（teach 计数型）：>=2 块 vs <=1 块
addSet('derivation_blocks', 'teach', 'derivation',
  [
    '$$u=1+x^{2}$$\n$$du=2x\\,dx$$',
    '第一步：代入 $u=1+x^{2}$\n第二步：化为 $\\frac{1}{2}\\int\\frac{du}{u}$\n第三步：得 $\\frac{1}{2}\\ln(1+x^{2})+C$',
    '$$f\'(x)=3x^{2}-3$$\n$$f\'(x)=0 \\Rightarrow x=\\pm 1$$',
    '先求驻点\n再比较端点\n最后取最大值',
    '$$\\sin x=x-\\frac{x^{3}}{6}+o(x^{3})$$\n$$\\tan x=x+\\frac{x^{3}}{3}+o(x^{3})$$',
    '令 $b_n=a_n+1$\n则 $b_{n+1}=3b_n$\n故 $a_n=3^{n}-1$',
  ],
  [
    '',
    '仅一行结论',
    '$$f\'(x)=e^{x}(x^{2}+2x)$$',
    '正确答案为 $1/2$',
    '  ',
    '无需推导，直接由定义得出',
  ]);

const rows = SAMPLES.map((s) => {
  const sig = evaluateQualitySignals(s.result, {});
  const value = sig[s.proxy];
  const detected = s.proxy === 'derivation_blocks' ? Number(value) >= 2 : value === true;
  const expected = s.label === 'positive';
  return {
    id: s.id,
    proxy: s.proxy,
    label: s.label,
    synthetic: true,
    raw: s.raw,
    observed: value,
    detected,
    expected,
    outcome: expected ? (detected ? 'TP' : 'FN') : (detected ? 'FP' : 'TN'),
    human_only_all_null: HUMAN_ONLY_DIMENSIONS.every((k) => sig.human_only?.[k] === null),
  };
});

const rate = (n, d) => (d ? Number((n / d).toFixed(4)) : null);
const summary = ALL_PROXIES.map((proxy) => {
  const g = rows.filter((r) => r.proxy === proxy);
  const pos = g.filter((r) => r.label === 'positive');
  const neg = g.filter((r) => r.label === 'negative');
  const tp = pos.filter((r) => r.detected).length;
  const tn = neg.filter((r) => !r.detected).length;
  const sensitivity = rate(tp, pos.length);
  const specificity = rate(tn, neg.length);
  return {
    proxy,
    n: g.length,
    positives: pos.length,
    negatives: neg.length,
    TP: tp, FN: pos.length - tp, TN: tn, FP: neg.length - tn,
    sensitivity,
    specificity,
    pass: sensitivity !== null && specificity !== null && sensitivity >= THRESHOLD && specificity >= THRESHOLD,
    missed_positive_ids: pos.filter((r) => !r.detected).map((r) => r.id),
    false_positive_ids: neg.filter((r) => r.detected).map((r) => r.id),
  };
});

// ── 真实语料探测：构造样本只能验证下限，这里才是漏检证据 ──────────────────
const CORPUS_PATH = path.join(REPORT_DIR, 'prompt-ab-8093-think-real-merged.json');
let corpusProbe = null;
if (fs.existsSync(CORPUS_PATH)) {
  const doc = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
  const results = Array.isArray(doc.results) ? doc.results : [];
  // 把 essence 置空 = 模拟修复前「narrative 排除 essence」的口径，得到可对照的前值
  const stripEssence = (r) => ({ ...r, fields: { ...(r.fields || {}), essence: '' } });
  const keys = [
    'actionable_hint', 'transfer_hint', 'explains_why',
    'cause_has_mechanism', 'structured_ids_present',
  ];
  const countHit = (items, key) =>
    items.filter((r) => evaluateQualitySignals(r, {})[key] === true).length;
  const current = Object.fromEntries(keys.map((k) => [k, countHit(results, k)]));
  const oldItems = results.map(stripEssence);
  const before = Object.fromEntries(keys.map((k) => [k, countHit(oldItems, k)]));
  const gained = results
    .filter((r) => evaluateQualitySignals(r, {}).actionable_hint
      && !evaluateQualitySignals(stripEssence(r), {}).actionable_hint)
    .map((r) => ({ case_id: r.case_id, essence: String(r.fields?.essence || '').slice(0, 160) }));
  corpusProbe = {
    source: 'reports/prompt-ab-8093-think-real-merged.json',
    source_note: '8093 Qwen3.8-9B-Distill 深度思考档 / 34 题真实真题集 / 真实模型输出。不是人工盲评，不是质量标注。',
    synthetic: false,
    n: results.length,
    current,
    before_field_fix: before,
    field_fix_note:
      'before_field_fix 通过把 essence 置空模拟修复前「narrative 排除 essence」的口径；' +
      '两列之差即字段口径造成的漏检，不是模型行为变化。',
    newly_detected_actionable: gained,
    still_missing_actionable_n: results.length - current.actionable_hint,
    reading: [
      'actionable_hint 的部分低命中来自字段口径（essence 被排除），而非模型完全没写改错指令。',
      'transfer_hint 前后均 0/34：这是真实深度缺口，不是量尺口径造成。',
      'explains_why 刻意排除 essence 以防「本质/原理」恒真，且词表只认显式元话语词；低命中不得读作「模型没讲为什么」。',
      'structured_ids_present 0/34 暴露 KPI §6.3.1「kq_id / cause_id 上线即锁死」的实现缺口。',
    ],
  };
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const payload = {
  schema: 1,
  generated_at: new Date().toISOString(),
  scope: '词表检出能力校准（非质量评价）',
  synthetic: true,
  NOT_formal_baseline: '构造文本样本，不是真实学生错题、不是人工盲评、不进 G1、不得推断 M1/M6',
  threshold: THRESHOLD,
  proxies: summary,
  constructed_samples_caveat:
    '构造样本照着词表写，全 1.0 属循环论证，只验证检出下限，不构成「词表无问题」的证据；' +
    '漏检证据见 corpus_probe（真实模型输出）。',
  corpus_probe: corpusProbe,
  human_only_all_null: rows.every((r) => r.human_only_all_null),
  samples: rows,
  caveat:
    '灵敏度低 = 词表太窄；特异度低 = 词表太宽。两者均不得读作归因质量好坏。' +
    '校准只说明词表能否检出它声称要检出的结构信号，不说明该结构与质量的相关性。',
};
fs.mkdirSync(REPORT_DIR, { recursive: true });
const jsonPath = path.join(REPORT_DIR, `quality-proxy-calibration-${ts}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

const md = [];
md.push('# 结构代理量词表校准（非质量评价）');
md.push('');
md.push(`- 生成时间：${payload.generated_at}`);
md.push('- 样本：人工构造的归因文本片段，全部 `synthetic: true`；**不是真实学生错题、不是人工盲评**。');
md.push(`- 达标线：灵敏度 / 特异度均 ≥ ${THRESHOLD}（仅针对词表检出能力）`);
md.push(`- 人工维度恒 null：${payload.human_only_all_null}`);
md.push('');
md.push('> ⚠️ 构造样本是照着词表写的，**全 1.0 属循环论证，只验证检出下限**；');
md.push('> 它不能证明词表在自然表达上够用。真正的漏检证据见下方「真实语料探测」。');
md.push('');
md.push('| 代理量 | 正/负 | TP | FN | TN | FP | 灵敏度 | 特异度 | 达标 |');
md.push('|---|---|---|---|---|---|---|---|---|');
for (const s of summary) {
  md.push(`| \`${s.proxy}\` | ${s.positives}/${s.negatives} | ${s.TP} | ${s.FN} | ${s.TN} | ${s.FP} | ${s.sensitivity} | ${s.specificity} | ${s.pass ? '✅' : '❌'} |`);
}
md.push('');
md.push('## 明细（漏检 / 误检）');
for (const s of summary) {
  md.push(`- \`${s.proxy}\`：漏检 ${s.missed_positive_ids.join(', ') || '无'}；误检 ${s.false_positive_ids.join(', ') || '无'}`);
}
md.push('');
if (corpusProbe) {
  md.push('## 真实语料探测（才是漏检证据）');
  md.push('');
  md.push(`- 来源：\`${corpusProbe.source}\``);
  md.push(`- ${corpusProbe.source_note}`);
  md.push(`- n = ${corpusProbe.n}；\`synthetic: false\`（真实模型输出，但仍**不是人工盲评、不是质量标注**）`);
  md.push('');
  md.push('| 代理量 | 修复前口径（排除 essence） | 当前口径 |');
  md.push('|---|---|---|');
  for (const k of Object.keys(corpusProbe.current)) {
    md.push(`| \`${k}\` | ${corpusProbe.before_field_fix[k]}/${corpusProbe.n} | ${corpusProbe.current[k]}/${corpusProbe.n} |`);
  }
  md.push('');
  md.push(corpusProbe.field_fix_note);
  md.push('');
  md.push(`字段口径修复后新增检出的改错指令（${corpusProbe.newly_detected_actionable.length} 条，附 essence 原文供人工判读）：`);
  for (const g of corpusProbe.newly_detected_actionable) {
    md.push(`- \`${g.case_id}\`：${g.essence}`);
  }
  md.push('');
  md.push(`当前口径仍未检出 \`actionable_hint\` 的条目：${corpusProbe.still_missing_actionable_n}/${corpusProbe.n}（词表仍偏窄 + 模型确实少写，两者不可分开归因）。`);
  md.push('');
  md.push('判读纪律：');
  for (const r of corpusProbe.reading) md.push(`- ${r}`);
  md.push('');
}
md.push('## 口径');
md.push('');
md.push(payload.caveat);
md.push('');
md.push('> 本校准只说明词表能否检出它声称要检出的结构信号；命中 ≠ 质量达标，未命中 ≠ 质量差。');
md.push('> 禁止用于 G1 闸门判定，禁止推断 M1 认可率 / M6 盲评准确率。');
const mdPath = path.join(REPORT_DIR, `quality-proxy-calibration-${ts}.md`);
fs.writeFileSync(mdPath, md.join('\n'), 'utf8');

console.log(`样本数 ${rows.length} | 人工维度恒 null: ${payload.human_only_all_null}`);
console.log('| 代理量 | 灵敏度 | 特异度 | 达标 |');
for (const s of summary) {
  console.log(`| ${s.proxy} | ${s.sensitivity} | ${s.specificity} | ${s.pass ? 'PASS' : 'FAIL'} |`);
  if (s.missed_positive_ids.length) console.log(`  漏检: ${s.missed_positive_ids.join(', ')}`);
  if (s.false_positive_ids.length) console.log(`  误检: ${s.false_positive_ids.join(', ')}`);
}
if (corpusProbe) {
  console.log('');
  console.log(`真实语料探测 n=${corpusProbe.n}（真实模型输出，非质量标注）— 修复前 -> 当前`);
  for (const k of Object.keys(corpusProbe.current)) {
    console.log(`  ${k}: ${corpusProbe.before_field_fix[k]} -> ${corpusProbe.current[k]}`);
  }
  console.log(`  仍未检出 actionable_hint: ${corpusProbe.still_missing_actionable_n}/${corpusProbe.n}`);
}
console.log(`报告: ${mdPath}`);
console.log(`数据: ${jsonPath}`);
