#!/usr/bin/env node
/**
 * quality-ab-compare.mjs — 离线 prompt 变体 A/B 的「结构代理量」对比（只读、可重跑）
 *
 * ── 口径纪律（DSR 诚实标定，不可放宽）──────────────────────────────────────
 * 1. 本脚本只比 **结构代理量**（布尔/计数信号），**不产出质量分、不下「质量变好」结论**。
 *    命中率上升只说明「出现了更多该结构信号」，不等于归因更触及本质、更能指导改错。
 *    K1.3 的本质分 / 可指导分 / 偏好 / Cohen's κ 必须由 2 人独立盲评产生。
 * 2. 输入题集是 `synthetic: true` 的**自造校准题集**，不是真实学生错题。
 *    **禁止**用于 G1 闸门判定、**禁止**推断 M1 认可率 / M6 盲评准确率、
 *    **禁止**写进对外材料当作真实样本。
 * 3. 量尺口径版本 RUBRIC_SCOPE 记录在产物里：`2026-11-07-wordlist-v2.1`。
 *    第一轮修复字段口径（actionable_hint / transfer_hint 纳入 essence，
 *    explains_why 继续排除防恒真）；第二轮补词表正则，用的是**照词表同义表达设计、
 *    承认循环论证**的 84 条构造样本（旧 6 类灵敏度 50–66.7% / 17 条漏检 0 误检 →
 *    7 类灵敏度与特异度全部 100%），**不得称为「非自证」**；另由真实语料探测互补。
 *    第三轮（v2.1）用真实模型输出上的实证误检收窄 2 条正则，见
 *    `scripts/quality-proxy-false-positive-probe.mjs`。
 *    **A/B 两侧同口径可比；与 ca2c5a8 首次基线、6358e12 第一轮、8283f96 v2 口径均不可直接比较**。
 * 4. 已知不对称：v0.5-depth 要求把「成立的依据」写进「本质」段，而 explains_why
 *    刻意排除 essence 以免「本质/原理」恒真 → 该代理量对 v0.5 存在系统性低估，
 *    其数值差异不得读作「v0.5 没讲为什么」。
 *
 * 用法：
 *   node scripts/quality-ab-compare.mjs \
 *     --report reports/prompt-ab-depth-calibration-merged.json \
 *     --set apps/api/src/tests/fixtures/quality-calibration-v1.json
 * 产物：reports/quality-ab-compare-<ts>.json / .md（reports/ 已 gitignore）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateQualitySignals,
  summarizeQuality,
  HUMAN_ONLY_DIMENSIONS,
  RUBRIC_SCOPE,
} from '../apps/api/src/tests/quality-rubric.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(REPO_ROOT, 'reports');
// RUBRIC_SCOPE 由 quality-rubric.mjs 单一权威导出，避免两处硬编码版本漂移。

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}
const REPORT = path.resolve(REPO_ROOT, arg('--report', 'reports/prompt-ab-depth-calibration-merged.json'));
const SET = path.resolve(REPO_ROOT, arg('--set', 'apps/api/src/tests/fixtures/quality-calibration-v1.json'));

const doc = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
const setDoc = JSON.parse(fs.readFileSync(SET, 'utf8'));
const results = Array.isArray(doc.results) ? doc.results : [];
const caseMap = new Map((setDoc.cases || []).map((c) => [c.id, c]));

// ── 输入完整性校验（不通过就退出，不强行出表）───────────────────────────────
const BASE = 'v0.2b-guard-trap';
const CAND = 'v0.5-depth';
const variants = [...new Set(results.map((r) => r.variant))].sort();
const ids = [...new Set(results.map((r) => r.case_id))].sort();
const combos = new Set(results.map((r) => `${r.case_id}|${r.variant}`));
const problems = [];
if (!setDoc.synthetic) problems.push('题集未显式标 synthetic:true，拒绝按校准集口径出表');
if (results.length !== 60) problems.push(`报告条数 ${results.length} != 60`);
if (ids.length !== 30) problems.push(`case_id 去重 ${ids.length} != 30`);
if (combos.size !== results.length) problems.push('存在重复 (case_id, variant) 组合');
if (!variants.includes(BASE) || !variants.includes(CAND)) problems.push(`变体不齐：${variants.join(',')}`);
for (const id of ids) if (!caseMap.has(id)) problems.push(`报告 case_id ${id} 不在题集中`);
for (const r of results) if (r.ok !== true || r.err != null) problems.push(`${r.case_id}/${r.variant} 调用未成功`);
if (problems.length) {
  console.error('[quality-ab-compare] 输入校验失败：');
  for (const p of problems) console.error('  -', p);
  process.exit(2);
}

const scored = results.map((r) => ({
  r,
  s: evaluateQualitySignals(r, caseMap.get(r.case_id) || {}),
}));

const PROXY_KEYS = [
  'contract_complete',
  'cause_has_empty_label',
  'cause_has_mechanism',
  'actionable_hint',
  'explains_why',
  'pitfall_section',
  'transfer_hint',
  'structured_ids_present',
];

/** cause_* 在 teach 模式为 null，分母必须用「适用条数」而不是 n，避免稀释。 */
function tally(list, key) {
  const applicable = list.filter((x) => x.s[key] !== null);
  return {
    hits: applicable.filter((x) => x.s[key] === true).length,
    applicable: applicable.length,
    null_n: list.length - applicable.length,
  };
}

function pct(n, d) {
  return d ? Number((n / d).toFixed(4)) : null;
}

function group(variant) {
  const list = scored.filter((x) => x.r.variant === variant);
  const proxies = Object.fromEntries(PROXY_KEYS.map((k) => [k, tally(list, k)]));
  const dist = { L1: 0, L2: 0, L3: 0, L4: 0 };
  for (const x of list) if (dist[x.s.depth_signal_level] !== undefined) dist[x.s.depth_signal_level]++;
  const chars = list.map((x) => x.r.chars || 0);
  const lat = list.map((x) => x.r.latency_ms || 0).sort((a, b) => a - b);
  const q = (p) => {
    if (!lat.length) return null;
    const i = (lat.length - 1) * p;
    const lo = Math.floor(i), hi = Math.ceil(i);
    // 末步舍入与 reports/depth-ab-merge.mjs 的 percentile() 统一为 1 位小数。
    // 用 Math.round 会把 12664.5 → 12665、12362.5 → 12363，造成跨产物看似不一致。
    return Number((lat[lo] + (lat[hi] - lat[lo]) * (i - lo)).toFixed(1));
  };
  return {
    variant,
    n: list.length,
    proxies,
    depth_signal_level_distribution: dist,
    derivation_blocks_mean: Number(
      (list.reduce((a, x) => a + (x.s.derivation_blocks || 0), 0) / list.length).toFixed(2)
    ),
    chars_mean: Number((chars.reduce((a, b) => a + b, 0) / chars.length).toFixed(1)),
    latency_p50_ms: q(0.5),
    human_only: summarizeQuality(list.map((x) => x.s)).human_only,
  };
}

const groups = { [BASE]: group(BASE), [CAND]: group(CAND) };

// ── 逐题配对：同一 case_id 两变体，看结构信号是「新增」还是「丢失」────────────
const paired = ids.map((id) => {
  const a = scored.find((x) => x.r.case_id === id && x.r.variant === BASE)?.s;
  const b = scored.find((x) => x.r.case_id === id && x.r.variant === CAND)?.s;
  const c = caseMap.get(id);
  const delta = {};
  for (const k of PROXY_KEYS) {
    if (a?.[k] === null || b?.[k] === null) { delta[k] = 'not_applicable'; continue; }
    delta[k] = a[k] === b[k] ? 'same' : b[k] ? 'gained' : 'lost';
  }
  return {
    case_id: id,
    subject: c?.subject,
    mode: c?.mode,
    trap: Boolean(c?.trap),
    depth_target: c?.depth_target ?? null,
    depth_signal_level: { [BASE]: a?.depth_signal_level, [CAND]: b?.depth_signal_level },
    delta,
  };
});

const deltaSummary = Object.fromEntries(PROXY_KEYS.map((k) => {
  const v = paired.map((p) => p.delta[k]);
  return [k, {
    gained: v.filter((x) => x === 'gained').length,
    lost: v.filter((x) => x === 'lost').length,
    same: v.filter((x) => x === 'same').length,
    not_applicable: v.filter((x) => x === 'not_applicable').length,
  }];
}));

const trapRows = paired.filter((p) => p.trap);
// 陷阱题零回归结论必须由结果动态生成，不得硬编码题号或结论文本；
// 只要有一条偏离固定写法，就如实列出供人工判读，不静默宣称「零回归」。
const TRAP_CLEAN_CAUSE = '解法正确，未发现错误';
const trapCauseRows = trapRows.flatMap((p) =>
  variants.map((v) => {
    const row = scored.find((x) => x.r.case_id === p.case_id && x.r.variant === v);
    return {
      case_id: p.case_id,
      variant: v,
      cause: String(row?.r?.fields?.cause || '').trim(),
    };
  })
);
const trapDeviations = trapCauseRows.filter((t) => t.cause !== TRAP_CLEAN_CAUSE);
const humanOnlyAllNull = scored.every(
  (x) => HUMAN_ONLY_DIMENSIONS.every((k) => x.s.human_only?.[k] === null)
);

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const payload = {
  schema: 1,
  generated_at: new Date().toISOString(),
  rubric_scope: RUBRIC_SCOPE,
  report: path.relative(REPO_ROOT, REPORT),
  set: path.relative(REPO_ROOT, SET),
  synthetic: setDoc.synthetic === true,
  NOT_formal_baseline:
    '自造校准题集，不是真实学生错题。禁止用于 G1 闸门判定、禁止推断 M1 认可率 / M6 盲评准确率、禁止写进对外材料当作真实样本。',
  scope_note:
    '只比结构代理量，不产出质量分、不下质量结论。A/B 两侧同口径可比；' +
    '与 ca2c5a8 首次基线、6358e12 第一轮（essence-scope-fix）、8283f96 第二轮（wordlist-v2）' +
    '均不可直接比较 —— 补词表与按真实语料实证误检收窄正则都改了量尺，数字差异来自量尺而非模型行为。',
  known_asymmetry:
    'v0.5-depth 要求把「成立的依据」写进「本质」段，而 explains_why 刻意排除 essence 防恒真 → 该代理量对 v0.5 系统性低估。',
  // 全部由 results 实算，不写死 0：校验日后若放宽，validation 也不会与真实数据脱节
  validation: {
    rows: results.length,
    unique_case_ids: ids.length,
    unique_combos: combos.size,
    variants,
    per_variant: Object.fromEntries(
      variants.map((v) => [v, results.filter((r) => r.variant === v).length])
    ),
    err_n: results.filter((r) => r.err != null).length,
    ok_false_n: results.filter((r) => r.ok !== true).length,
    essence_present_n: results.filter((r) => Boolean(r.fields?.essence)).length,
  },
  groups,
  paired_deltas: deltaSummary,
  paired_detail: paired,
  trap_cause_audit: {
    expected_clean_cause: TRAP_CLEAN_CAUSE,
    n: trapCauseRows.length,
    clean_n: trapCauseRows.length - trapDeviations.length,
    deviations: trapDeviations,
    note: '由 results 逐条实算；deviations 非空时必须人工判读是否强行归因，不得宣称零回归。',
  },
  trap_cases: trapRows,
  human_only_all_null: humanOnlyAllNull,
  disclaimer:
    '结构代理量命中 ≠ 归因质量达标；本质分 / 可指导分 / 偏好 / κ 必须由 2 人独立盲评产生。' +
    '本报告不得据以推断 M1 认可率或 M6 盲评准确率，不构成 G1 闸门证据。',
};

fs.mkdirSync(REPORT_DIR, { recursive: true });
const jsonPath = path.join(REPORT_DIR, `quality-ab-compare-${ts}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

const md = [];
md.push('# 归因深度候选 A/B：结构代理量对比（合成校准集，非质量评价）');
md.push('');
md.push(`- 生成时间：${payload.generated_at}`);
md.push(`- 量尺口径：\`${RUBRIC_SCOPE}\`（A/B 两侧**同口径可比**；与 ca2c5a8 首次基线、6358e12 第一轮、8283f96 第二轮 v2 均**不可比** —— 补词表 + 真实语料实证误检收窄正则，数字差异来自量尺而非模型行为）`);
md.push(`- 报告：\`${payload.report}\`；题集：\`${payload.set}\``);
md.push(`- 校验：${payload.validation.rows} 条 / ${payload.validation.unique_case_ids} 题 / ${payload.validation.unique_combos} 唯一组合 / err ${payload.validation.err_n} / ok=false ${payload.validation.ok_false_n} / essence ${payload.validation.essence_present_n} 条 / 每变体 ${JSON.stringify(payload.validation.per_variant)}`);
md.push(`- 人工维度恒 null：${payload.human_only_all_null}`);
md.push('');
md.push('> ⚠️ **本表只比结构代理量，不产出质量分、不下「质量变好」结论。**');
md.push('> 命中率上升只说明「出现了更多该结构信号」，不等于归因更触及本质、更能指导改错。');
md.push('> ⚠️ 题集 `synthetic: true`，不是真实学生错题；禁止用于 G1 判定、禁止推断 M1/M6。');
md.push('');
md.push('## 一、按变体汇总');
md.push('');
md.push('| 代理量 | v0.2b 命中/适用 | v0.5 命中/适用 | Δ | 说明 |');
md.push('|---|---|---|---|---|');
for (const k of PROXY_KEYS) {
  const a = groups[BASE].proxies[k], b = groups[CAND].proxies[k];
  const d = b.hits - a.hits;
  const note = a.null_n ? `${a.null_n} 条不适用(teach)` : '';
  md.push(`| \`${k}\` | ${a.hits}/${a.applicable} | ${b.hits}/${b.applicable} | ${d > 0 ? '+' : ''}${d} | ${note} |`);
}
md.push('');
md.push('| 其他信号 | v0.2b | v0.5 |');
md.push('|---|---|---|');
md.push(`| depth_signal_level 分布 | ${JSON.stringify(groups[BASE].depth_signal_level_distribution)} | ${JSON.stringify(groups[CAND].depth_signal_level_distribution)} |`);
md.push(`| derivation_blocks 均值 | ${groups[BASE].derivation_blocks_mean} | ${groups[CAND].derivation_blocks_mean} |`);
md.push(`| chars 均值 | ${groups[BASE].chars_mean} | ${groups[CAND].chars_mean} |`);
md.push(`| latency p50 (ms) | ${groups[BASE].latency_p50_ms} | ${groups[CAND].latency_p50_ms} |`);
md.push('');
md.push('## 二、逐题配对（同一题两变体）');
md.push('');
md.push('| 代理量 | 新增命中 | 丢失命中 | 不变 | 不适用 |');
md.push('|---|---|---|---|---|');
for (const k of PROXY_KEYS) {
  const d = deltaSummary[k];
  md.push(`| \`${k}\` | ${d.gained} | ${d.lost} | ${d.same} | ${d.not_applicable} |`);
}
md.push('');
// 本段由结果动态生成：题号、条数、结论都从 trapCauseRows 实算，不写死
md.push(`陷阱题 ${trapRows.length} 道（${trapRows.map((p) => p.case_id).join('/')}）× ${variants.length} 变体 = ${trapCauseRows.length} 条错因行：`);
if (trapDeviations.length === 0) {
  md.push(`全部为「${TRAP_CLEAN_CAUSE}」，未出现为追求深度而编造错因。`);
} else {
  md.push(`⚠️ **${trapDeviations.length} 条偏离固定写法，须人工判读是否强行归因**（不得宣称零回归）：`);
  for (const t of trapDeviations) {
    md.push(`- \`${t.case_id}\` / \`${t.variant}\`：${t.cause || '(空)'}`);
  }
}
md.push('逐题配对明细见 JSON `trap_cases` / `trap_cause_audit` / `paired_detail`；本段由结果动态生成，非硬编码。');
md.push('');
md.push('## 三、判读纪律');
md.push('');
md.push(`- ${payload.known_asymmetry}`);
md.push('- `transfer_hint` 是 L4 的结构代理；词表检出能力已校准，但**该结构与质量的相关性未校准**。');
md.push('- `structured_ids_present` 检出的是 KPI §6.3.1「kq_id / cause_id 上线即锁死」的实现缺口，与 prompt 变体无关。');
md.push('- 第二轮构造样本系**照词表同义表达设计、承认循环论证**（不得称「非自证」）：它测出旧 6 类灵敏度 50–66.7% / 17 条漏检 0 误检 → 补词表后本样本 7 类 100%，**只证明本样本无漏检/无误检**，不证明真实语料无误检；真实语料探测见 `quality-proxy-corpus-probe.mjs`。');
md.push('- 第三轮（v2.1）以 `scripts/quality-proxy-false-positive-probe.mjs` 在 8093 真实语料 34 + A/B 合成 60 上逐条复核新增正则，实证 2 处误检（rc05 裸「原因」、qy01/v0.5-depth 裸「同样」）并收窄 2 条正则；收窄后构造样本仍 7 类 100%、单测 18/18。');
md.push('- 本质分 / 可指导分 / 偏好 / Cohen\'s κ 仍为 `null`，须由 2 人独立盲评产生；本报告不提供任何质量结论。');
md.push('');
md.push(`> ${payload.disclaimer}`);
const mdPath = path.join(REPORT_DIR, `quality-ab-compare-${ts}.md`);
fs.writeFileSync(mdPath, md.join('\n'), 'utf8');

console.log(`口径 ${RUBRIC_SCOPE} | ${payload.validation.rows} 条 | 人工维度恒 null: ${humanOnlyAllNull}`);
console.log('| 代理量 | v0.2b | v0.5 | Δ | 新增/丢失 |');
for (const k of PROXY_KEYS) {
  const a = groups[BASE].proxies[k], b = groups[CAND].proxies[k], d = deltaSummary[k];
  console.log(`| ${k} | ${a.hits}/${a.applicable} | ${b.hits}/${b.applicable} | ${b.hits - a.hits > 0 ? '+' : ''}${b.hits - a.hits} | ${d.gained}/${d.lost} |`);
}
console.log('depth 分布 v0.2b:', JSON.stringify(groups[BASE].depth_signal_level_distribution));
console.log('depth 分布 v0.5 :', JSON.stringify(groups[CAND].depth_signal_level_distribution));
console.log(`报告: ${mdPath}`);
console.log(`数据: ${jsonPath}`);
