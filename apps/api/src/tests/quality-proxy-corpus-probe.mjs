#!/usr/bin/env node
/**
 * quality-proxy-corpus-probe.mjs — 真实模型输出上的代理量/字段口径探测（只读、离线、可重跑）
 *
 * 为什么独立成脚本：v2 校准（quality-proxy-calibration.mjs）用**构造样本**测
 * 「词表能否检出目标结构」；但构造样本无论写得多自然，仍是人造文本。本脚本用
 * 8093 深度思考档 34 题真题集的**真实模型输出**做第二路证据，并复现「字段口径
 * 修复」前后的差异。两者互补，互不替代。
 *
 * ── 口径纪律（DSR 诚实标定）────────────────────────────────────────────────
 * 1. 本脚本只测「代理量在当前词表下的命中数」与「字段口径造成的差值」，
 *    **不产出质量分、不下质量结论**。命中 ≠ 质量达标，未命中 ≠ 质量差。
 * 2. 语料是真实模型输出，但**不是真实学生错题、不是人工盲评、不是质量标注**；
 *    结果不进 G1、不推断 M1 认可率 / M6 盲评准确率。
 * 3. `before_field_fix` 通过把 `essence` 置空来**模拟**修复前口径（不是改词表、
 *    不是历史回放），两列之差只能读作字段口径造成的漏检，不能读作模型行为变化。
 * 4. 纯离线：只读 reports/ 下已有报告，只写 reports/ 产物；不联网、不启 3001、
 *    不碰生产库、不改源码。
 *
 * 用法：node apps/api/src/tests/quality-proxy-corpus-probe.mjs [--report <合并报告>]
 * 产物：reports/quality-proxy-corpus-probe-<ts>.json / .md（reports/ 已 gitignore）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateQualitySignals } from './quality-rubric.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const REPORTS = path.join(ROOT, 'reports');
const args = process.argv.slice(2);
const iReport = args.indexOf('--report');
const CORPUS = (iReport >= 0 && args[iReport + 1] && !args[iReport + 1].startsWith('--'))
  ? path.resolve(ROOT, args[iReport + 1])
  : path.join(REPORTS, 'prompt-ab-8093-think-real-merged.json');

const KEYS = [
  'contract_complete',
  'cause_has_empty_label',
  'cause_has_mechanism',
  'actionable_hint',
  'explains_why',
  'pitfall_section',
  'transfer_hint',
  'structured_ids_present',
];

if (!existsSync(CORPUS)) {
  console.log(`[corpus-probe] 未找到语料 ${path.relative(ROOT, CORPUS)}，跳过（本探测为可选项，非错误）。`);
  process.exit(0);
}

const doc = JSON.parse(readFileSync(CORPUS, 'utf8'));
const results = Array.isArray(doc.results) ? doc.results : [];
if (!results.length) {
  console.error('[corpus-probe] 语料 results 为空');
  process.exit(2);
}

/** 把 essence 置空 = 模拟修复前「narrative 排除 essence」的口径。 */
const stripEssence = (r) => ({ ...r, fields: { ...(r.fields || {}), essence: '' } });
const countHit = (items, key) =>
  items.filter((r) => evaluateQualitySignals(r, {})[key] === true).length;

const current = Object.fromEntries(KEYS.map((k) => [k, countHit(results, k)]));
const oldItems = results.map(stripEssence);
const before = Object.fromEntries(KEYS.map((k) => [k, countHit(oldItems, k)]));

const gained = results
  .filter((r) => evaluateQualitySignals(r, {}).actionable_hint
    && !evaluateQualitySignals(stripEssence(r), {}).actionable_hint)
  .map((r) => ({ case_id: r.case_id, essence: String(r.fields?.essence || '').slice(0, 160) }));

const payload = {
  schema: 1,
  generated_at: new Date().toISOString(),
  corpus: path.relative(ROOT, CORPUS),
  corpus_note:
    '8093 Qwen3.8-9B-Distill 深度思考档 / 34 题真实真题集 / 真实模型输出。不是真实学生错题、不是人工盲评、不是质量标注。',
  synthetic: false,
  n: results.length,
  current,
  before_field_fix: before,
  field_fix_note:
    'before_field_fix 由 essence 置空模拟修复前口径；两列之差 = 字段口径造成的漏检，不是模型行为变化。',
  newly_detected_actionable: gained,
  still_missing_actionable_n: results.length - current.actionable_hint,
  reading: [
    'actionable_hint 的部分低命中来自字段口径（essence 被排除），而非模型完全没写改错指令。',
    'transfer_hint 前后差值若仍为 0，说明该处为真实深度缺口，不是量尺口径造成。',
    'explains_why 刻意排除 essence 以防「本质/原理」恒真；低命中不得读作「模型没讲为什么」。',
    'structured_ids_present 低命中暴露 KPI §6.3.1「kq_id / cause_id 上线即锁死」的实现缺口。',
    '本探测只说明词表/口径的检出情况；代理量与归因质量的相关性仍须人工盲评校准。',
  ],
  disclaimer:
    '不进 G1 闸门、不推断 M1 认可率 / M6 盲评准确率；本质分 / 可指导分 / 偏好 / κ 必须由 2 人独立盲评产生。',
};

mkdirSync(REPORTS, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const jsonPath = path.join(REPORTS, `quality-proxy-corpus-probe-${ts}.json`);
writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

const md = [];
md.push('# 真实语料代理量 / 字段口径探测（非质量评价）');
md.push('');
md.push(`- 生成时间：${payload.generated_at}`);
md.push(`- 语料：\`${payload.corpus}\`，n=${payload.n}`);
md.push(`- ${payload.corpus_note}`);
md.push('');
md.push('| 代理量 | 修复前口径（排除 essence） | 当前口径 |');
md.push('|---|---|---|');
for (const k of KEYS) md.push(`| \`${k}\` | ${before[k]}/${payload.n} | ${current[k]}/${payload.n} |`);
md.push('');
md.push(payload.field_fix_note);
md.push('');
md.push(`字段口径修复后新增检出的改错指令（${gained.length} 条，附 essence 原文供人工判读）：`);
for (const g of gained) md.push(`- \`${g.case_id}\`：${g.essence}`);
md.push('');
md.push(`当前口径仍未检出 \`actionable_hint\`：${payload.still_missing_actionable_n}/${payload.n}。`);
md.push('');
md.push('## 判读纪律');
for (const r of payload.reading) md.push(`- ${r}`);
md.push('');
md.push(`> ${payload.disclaimer}`);
const mdPath = path.join(REPORTS, `quality-proxy-corpus-probe-${ts}.md`);
writeFileSync(mdPath, md.join('\n'), 'utf8');

console.log(`真实语料探测 n=${payload.n}（${payload.corpus}）— 修复前 -> 当前`);
for (const k of KEYS) console.log(`  ${k}: ${before[k]} -> ${current[k]}`);
console.log(`  新增检出的改错指令: ${gained.length} | 仍未检出: ${payload.still_missing_actionable_n}/${payload.n}`);
console.log(`报告: ${mdPath}`);
console.log(`数据: ${jsonPath}`);
