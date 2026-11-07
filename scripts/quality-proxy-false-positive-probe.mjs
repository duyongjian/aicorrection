#!/usr/bin/env node
/**
 * quality-proxy-false-positive-probe.mjs — 词表「新增正则」误检探针（只读、离线）
 *
 * 背景：2026-11-07 第二轮词表校准（提交 8283f96）在 6 个词表里补了若干正则。
 * 校准用的构造样本是照词表同义表达设计的，特异度 100% 只能说明「在本样本上无误检」，
 * **不能证明在真实模型输出上无误检**。本脚本补上这块证据：
 *   用 git show 6358e12 自取旧词表 → 与当前词表求差集 → 列出每条「新增正则」
 *   在 8093 真实语料 34 条与深度 A/B 合成 60 条上的**每一处命中明细**，供人工判读。
 *
 * 口径与 quality-rubric.mjs 的 evaluateQualitySignals 严格一致：
 *   - cause_has_empty_label / cause_has_mechanism → 只看 fields.cause（且 mode=diagnose）
 *   - actionable_hint / transfer_hint            → actionNarrative = narrative + essence
 *   - explains_why                              → narrative（刻意排除 essence）
 *   narrative = [cause, derivation, pitfalls].filter(Boolean).join('\n')
 *
 * 本脚本不修改任何产物、不参与门禁、不给质量结论；输出即证据，判定权在人工。
 * 用法：在仓库根执行 `node scripts/quality-proxy-false-positive-probe.mjs`
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const KEYS = [
  'EMPTY_CAUSE_LABELS',
  'MECHANISM_PATTERNS',
  'ACTIONABLE_PATTERNS',
  'EXPLAIN_WHY_PATTERNS',
  'TRANSFER_PATTERNS',
];

/** 从源码里把 6 个词表常量求出来（常量均为内部 const，不含 export，可直接求值）。 */
function extractWordlists(src) {
  const s = src.indexOf('const EMPTY_CAUSE_LABELS');
  const e = src.indexOf('const STRUCTURED_ID_PATTERN');
  if (s < 0 || e < 0 || e <= s) throw new Error('词表常量区定位失败：源码结构已变化，请人工核对');
  return new Function(`${src.slice(s, e)}\nreturn {${KEYS.join(',')}};`)();
}

const NEW_SRC = fs.readFileSync('apps/api/src/tests/quality-rubric.mjs', 'utf8');
const OLD_SRC = execFileSync(
  'git',
  ['show', '6358e12:apps/api/src/tests/quality-rubric.mjs'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
);
const OLD = extractWordlists(OLD_SRC);
const NEW = extractWordlists(NEW_SRC);

/** 以正则源码字符串求差集，得到「第二轮新增」的正则。 */
const added = {};
for (const k of KEYS) {
  const oldSet = new Set(OLD[k].map((r) => r.source));
  added[k] = NEW[k].filter((r) => !oldSet.has(r.source));
}

/** 每条新增正则对应检查哪段文本（与 evaluateQualitySignals 对齐）。 */
const SCOPE = {
  EMPTY_CAUSE_LABELS: 'cause',
  MECHANISM_PATTERNS: 'cause',
  ACTIONABLE_PATTERNS: 'actionNarrative',
  EXPLAIN_WHY_PATTERNS: 'narrative',
  TRANSFER_PATTERNS: 'actionNarrative',
};

function parts(r) {
  const f = r?.fields || {};
  const cause = String(f.cause || '');
  const derivation = String(f.derivation || '');
  const pitfalls = String(f.pitfalls || '');
  const essence = String(f.essence || '');
  const narrative = [cause, derivation, pitfalls].filter(Boolean).join('\n');
  const actionNarrative = [narrative, essence].filter(Boolean).join('\n');
  return { cause, narrative, actionNarrative };
}

const CORPORA = [
  { name: '8093真实语料34', file: 'reports/prompt-ab-8093-think-real-merged.json' },
  { name: '深度A/B合成60', file: 'reports/prompt-ab-depth-calibration-merged.json' },
];

const lines = [];
const out = (s = '') => lines.push(s);
const summary = { added_patterns: {}, hits_total: 0, hits_by_key: {}, corpora: {} };

out('# 词表新增正则误检探针（只读）');
out();
out(`- 旧词表来源：\`git show 6358e12:apps/api/src/tests/quality-rubric.mjs\``);
out(`- 新词表来源：\`apps/api/src/tests/quality-rubric.mjs\`（工作树当前版本）`);
out(`- 判定纪律：本脚本只列命中明细，**误检与否由人工判读**；命中 ≠ 质量达标，未命中 ≠ 质量差。`);
out();

out('## 1. 第二轮新增正则清单');
for (const k of KEYS) {
  summary.added_patterns[k] = added[k].length;
  out(`- ${k}：新增 ${added[k].length} 条`);
  added[k].forEach((r, i) => out(`    ${i + 1}. \`${r.source}\``));
}
out();

for (const c of CORPORA) {
  const j = JSON.parse(fs.readFileSync(c.file, 'utf8'));
  const rows = Array.isArray(j) ? j : j.results || [];
  const corpusStat = { n: rows.length, hits: 0, by_key: {} };
  out(`## 2. ${c.name}（n=${rows.length}）新增正则命中明细`);
  let printed = 0;
  for (const r of rows) {
    const p = parts(r);
    const mode = r.mode === 'teach' ? 'teach' : 'diagnose';
    for (const k of KEYS) {
      const scope = SCOPE[k];
      // 诊断专属词表只在 diagnose + 有错因时生效，与 evaluateQualitySignals 一致
      if ((k === 'EMPTY_CAUSE_LABELS' || k === 'MECHANISM_PATTERNS') && (mode !== 'diagnose' || !p.cause)) continue;
      const text = p[scope];
      if (!text) continue;
      for (const re of added[k]) {
        const m = text.match(re);
        if (!m) continue;
        printed++;
        corpusStat.hits++;
        summary.hits_total++;
        summary.hits_by_key[k] = (summary.hits_by_key[k] || 0) + 1;
        corpusStat.by_key[k] = (corpusStat.by_key[k] || 0) + 1;
        out(`- [${k}] ${r.case_id} / ${r.variant} / ${mode} / ${scope}`);
        out(`  - 正则：\`${re.source}\``);
        out(`  - 命中子串：\`${m[0]}\``);
        out(`  - 全文：${String(r.text || '').replace(/\n/g, ' ⏎ ').slice(0, 420)}`);
      }
    }
  }
  if (printed === 0) out('- （无命中）');
  summary.corpora[c.name] = corpusStat;
  out();
}

out('## 3. 汇总');
out(`- 新增正则命中总数：${summary.hits_total}`);
for (const k of KEYS) out(`- ${k}：${summary.hits_by_key[k] || 0} 处`);
out();
out('> 注意：同一条记录可能被多条正则命中；此处统计的是「正则×记录」的命中处数，不是记录数。');
out('> 若某条正则的命中子串并不表达该结构信号（例如「原因」出现在「直接原因」里却算作解释了为什么），');
out('> 应判为误检并收窄词表；收窄后须重跑 quality-proxy-calibration.mjs、');
out('> quality-proxy-corpus-probe.mjs、scripts/quality-ab-compare.mjs 并同步所有下游文档数字。');

console.log(lines.join('\n'));
