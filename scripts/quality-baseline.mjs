#!/usr/bin/env node
/**
 * quality-baseline.mjs — 归因质量基线（A 层落地）
 *
 * 用法：node scripts/quality-baseline.mjs
 * 产出：reports/quality-baseline-<ts>.json / .md
 *
 * 纯离线：只读 reports/*.json + fixtures/*.json，不连模型服务、不启 3001、不碰生产库、
 * 不修改任何题集或判定式。机器只产出结构代理量；本质分/可指导分/偏好/κ 恒为待人工盲评。
 *
 * 口径纪律见 apps/api/src/tests/quality-rubric.mjs 顶部与 docs/归因质量量尺A层落地.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateQualitySignals,
  summarizeQuality,
  buildReviewQueue,
  HUMAN_ONLY_DIMENSIONS,
  DEPTH_LEVELS,
  RUBRIC_SCOPE,
} from '../apps/api/src/tests/quality-rubric.mjs';

const ROOT = path.resolve(process.cwd());
const FIX = 'apps/api/src/tests/fixtures';

/** 基线样本：8093 深度思考档三份 + 8092 非思考档两份作跨模型对照。 */
const SPECS = [
  {
    label: '8093 深度思考档 · 34 题门禁',
    cohort: '8093-think',
    report: 'reports/prompt-ab-8093-think-real-merged.json',
    set: `${FIX}/prompt-ab-set-realexam.json`,
    note: 'real-exam-v3，34 题；门禁 27/1/6、陷阱 0/1',
  },
  {
    label: '8093 深度思考档 · 12 题单调专项',
    cohort: '8093-think',
    report: 'reports/prompt-ab-2026-11-06T05-34-52-8093-think-mono.json',
    set: `${FIX}/prompt-ab-set-monotonic.json`,
    note: 'monotonic-v1，原题 10 次采样 + 2 道反号题',
  },
  {
    label: '8093 深度思考档 · 反号题重复采样 8 条',
    cohort: '8093-think',
    report: 'reports/prompt-ab-2026-11-07T06-25-22-8093-think-repeat.json',
    set: 'reports/8093-eval/repeat-set.json',
    note: 'nx05×5 + my01×3；用于复核答案行套模板',
  },
  {
    label: '8092 非思考档 · 33 题 v2 集（对照）',
    cohort: '8092-baseline',
    report: 'reports/prompt-ab-2026-11-06T02-16-22-9b-v2set.json',
    set: `${FIX}/prompt-ab-set-realexam.json`,
    note: 'v0.1 与 v0.2b 各 33 题；历史报告用 v3 题集，新增 nx05 无对应输出',
  },
  {
    label: '8092 非思考档 · 12 题三变体 A/B（对照）',
    cohort: '8092-baseline',
    report: 'reports/prompt-ab-2026-11-06T03-14-43-9b-mono-ab.json',
    set: `${FIX}/prompt-ab-set-monotonic.json`,
    note: 'guard / v0.2c / v0.2d 各 12 题',
  },
];

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function pctText(hits, n) {
  return n ? `${hits}/${n} (${((hits / n) * 100).toFixed(1)}%)` : 'n/a';
}

/** 汇总历史人工盲评计分文件（若存在），明确区分「模拟演练」与正式盲评。 */
function humanReviewHistory() {
  const dir = path.join(ROOT, 'reports');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^blind-.*-计分\.json$/.test(f)).sort()
    : [];
  return files.map((f) => {
    const d = readJson(`reports/${f}`);
    const simulated = (d.files || []).some((x) => /sim-|模拟|演练/i.test(String(x)));
    return {
      file: `reports/${f}`,
      n_problems: d.inter_rater?.n ?? null,
      rater_files: d.files || [],
      simulated,
      variants: (d.variants || []).map((v) => ({
        variant: v.variant,
        essence_mean: v.essence_mean,
        guide_mean: v.guide_mean,
        direction_ok_rate: v.direction_ok_rate,
      })),
      cohen_kappa_direction: d.inter_rater?.cohen_kappa_direction ?? null,
      usable_as_formal_baseline: !simulated && (d.inter_rater?.n ?? 0) >= 50,
    };
  });
}

const rows = [];
const errors = [];
for (const spec of SPECS) {
  try {
    const report = readJson(spec.report);
    const setDoc = readJson(spec.set);
    const caseMap = new Map((setDoc.cases || []).map((c) => [c.id, c]));
    const results = report.results || [];
    const unmatched = results.filter((r) => !caseMap.has(r.case_id)).map((r) => r.case_id);

    const byVariant = new Map();
    for (const r of results) {
      const s = evaluateQualitySignals(r, caseMap.get(r.case_id) || {});
      const key = String(r.variant || 'unknown');
      if (!byVariant.has(key)) byVariant.set(key, []);
      byVariant.get(key).push(s);
    }
    const variants = [...byVariant.entries()].map(([variant, signals]) => ({
      variant,
      n: signals.length,
      summary: summarizeQuality(signals),
      review_queue: buildReviewQueue(signals),
    }));
    rows.push({
      ...spec,
      set_version: setDoc.version ?? null,
      total_results: results.length,
      unmatched_case_ids: [...new Set(unmatched)],
      variants,
    });
  } catch (e) {
    errors.push({ spec: spec.label, error: e instanceof Error ? e.message : String(e) });
  }
}

const humanHistory = humanReviewHistory();
const formalBaseline = humanHistory.filter((h) => h.usable_as_formal_baseline);

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outJson = path.join(ROOT, 'reports', `quality-baseline-${ts}.json`);
const outMd = path.join(ROOT, 'reports', `quality-baseline-${ts}.md`);

const payload = {
  generated_at: new Date().toISOString(),
  schema: 1,
  scope: 'A 层：归因质量量尺落地后的首次基线（结构代理量，按当前量尺口径重算）',
  rubric_scope: RUBRIC_SCOPE,
  rubric_scope_note:
    '本脚本会重新调用 evaluateQualitySignals，词表一改数字即变；跨版本数字不可直接比较，差异来自量尺而非模型行为。',
  discipline: {
    machine_only_proxies: true,
    human_only_dimensions: [...HUMAN_ONLY_DIMENSIONS],
    human_only_values: null,
    depth_levels: { ...DEPTH_LEVELS },
    proxy_caveat:
      '代理量由固定词表命中得出；词表「检出能力」已在构造样本上校准（该样本承认循环论证）' +
      '并经真实语料误检探针复核，但「该结构能否预测归因质量」的相关性仍未校准：' +
      '命中 ≠ 质量达标，未命中 ≠ 质量差；不得据本基线推断 M1 认可率 / M6 盲评准确率。',
    gate_impact: '不参与 auto-eval 的 PASS/PARTIAL/FAIL 判定，不改变 attrib:regress 门禁结果。',
  },
  human_review: {
    status: formalBaseline.length ? 'FORMAL_BASELINE_EXISTS' : 'PENDING_FORMAL_BLIND_REVIEW',
    history: humanHistory,
    note: formalBaseline.length
      ? '存在满足 n≥50 且非模拟的历史盲评，可作为正式基线。'
      : '历史仅有 6 题模拟演练（sim-r*.csv），本质分 3.50 不构成基线；K1.3 要求 50–100 条真实学生错题 + 2 人独立评分。',
  },
  errors,
  reports: rows,
};

fs.writeFileSync(outJson, JSON.stringify(payload, null, 2), 'utf8');

const md = [];
md.push('# 归因质量基线 · A 层落地');
md.push(`\n生成时间：${payload.generated_at}`);
md.push(`\n范围：${payload.scope}`);
md.push(`\n量尺口径：\`${payload.rubric_scope}\` —— ${payload.rubric_scope_note}`);
md.push('\n> ⚠️ **口径纪律**：本报告只含**结构代理量**（词表命中），不是质量分。');
md.push('> 命中 ≠ 质量达标，未命中 ≠ 质量差（词表检出能力已校准，但代理量与质量的相关性未校准）；');
md.push('> 本质分 1–5 / 可指导改错分 1–5 / 偏好 / Cohen\'s κ **机器恒不给分**，须走人工盲评。');
md.push('> 本报告不参与 auto-eval 判定、不改变 attrib:regress 门禁结果，也不得用于推断 M1 / M6。');

md.push('\n## 1. 一句话结论');
if (formalBaseline.length) {
  md.push('\n已存在正式盲评基线，见第 4 节；下方代理量仅作结构诊断。');
} else {
  md.push('\n**「归因是否触及本质 / 能否指导改错」目前没有正式基线数据**：历史只有 6 题模拟演练，机器不给这两项打分。');
  md.push('本轮能确认的是可观测的结构缺口（结构化 ID、深度目标标定、迁移/变式信号），不是质量结论。');
}

md.push('\n## 2. 各报告 × 变体的结构代理量');
md.push('\n| 报告 | 变体 | n | 契约齐全 | 因果机制(诊断) | 可操作改错 | 解释「为什么」 | 迁移/变式 | 结构化 ID | 深度目标未标定 | L3+L4 | 人工待评 |');
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const row of rows) {
  for (const v of row.variants) {
    const p = v.summary.proxies;
    const d = p.depth_signal_level_distribution;
    md.push(`| ${row.label} | \`${v.variant}\` | ${v.n} | ${pctText(p.contract_complete.hits, v.n)} | ${pctText(p.cause_has_mechanism.hits, v.summary.diagnose_n)} | ${pctText(p.actionable_hint.hits, v.n)} | ${pctText(p.explains_why.hits, v.n)} | ${pctText(p.transfer_hint.hits, v.n)} | ${pctText(p.structured_ids_present.hits, v.n)} | ${v.summary.depth_target_unspecified_count}/${v.n} | ${d.L3 + d.L4}/${v.n} | ${v.summary.review_queue_size}/${v.n} |`);
  }
}

md.push('\n> ⚠️ **跨题集不可比**：各报告题型/措辞/重复采样结构不同（单调专项 12 题全是同题重复），代理量命中率跨报告比较无意义；只能在**同题集、同题量**下做改动前后对照。典型反例：8092 `v0.2d` 的「可操作改错」6/12 高于 8093 门禁的 2/34，这反映的是题型差异，不是归因质量差异。');
md.push('\n## 3. 结构信号等级分布（L1–L4，不是质量分）');
md.push('\n| 报告 | 变体 | L1 | L2 | L3 | L4 | 讲解推导块均值 |');
md.push('|---|---|---|---|---|---|---|');
for (const row of rows) {
  for (const v of row.variants) {
    const d = v.summary.proxies.depth_signal_level_distribution;
    md.push(`| ${row.label} | \`${v.variant}\` | ${d.L1} | ${d.L2} | ${d.L3} | ${d.L4} | ${v.summary.proxies.derivation_blocks_mean ?? 'n/a'} |`);
  }
}
md.push('\n`DEPTH_LEVELS` 定义：' + Object.entries(DEPTH_LEVELS).map(([k, v]) => `${k}=${v}`).join('；'));

md.push('\n## 4. 人工盲评状态（本质分 / 可指导分 / κ）');
if (!humanHistory.length) {
  md.push('\n未发现任何 `reports/blind-*-计分.json`，人工维度全部为待评。');
} else {
  md.push('\n| 计分文件 | 题数 | 评分表 | 模拟演练? | 本质均值 | 可指导均值 | κ(方向) | 可作正式基线? |');
  md.push('|---|---|---|---|---|---|---|---|');
  for (const h of humanHistory) {
    const ess = h.variants.map((v) => `${v.variant}: ${v.essence_mean}`).join(' / ');
    const guide = h.variants.map((v) => `${v.variant}: ${v.guide_mean}`).join(' / ');
    md.push(`| \`${h.file}\` | ${h.n_problems ?? '?'} | ${(h.rater_files || []).join(', ')} | ${h.simulated ? '✅ 是' : '否'} | ${ess} | ${guide} | ${h.cohen_kappa_direction ?? '?'} | ${h.usable_as_formal_baseline ? '是' : '**否**'} |`);
  }
  md.push(`\n状态：\`${payload.human_review.status}\`。${payload.human_review.note}`);
}

md.push('\n## 5. 缺口清单（可观测事实，非质量结论）');
const main = rows[0]?.variants?.[0]?.summary;
if (main) {
  const p = main.proxies;
  md.push(`\n- **结构化 ID（KPI §6.3.1「上线即锁死」项）**：主报告 ${p.structured_ids_present.hits}/${main.n} 命中，即当前三行/五段文本契约未产出 \`kq_id\` / \`cause_id\`。`);
  md.push(`- **深度目标标定**：主报告 ${main.depth_target_unspecified_count}/${main.n} 题未标 \`depth_target\`，产品侧尚未定义逐题目标深度（L1–L4）。`);
  md.push(`- **迁移/变式信号**：主报告 ${p.transfer_hint.hits}/${main.n} 命中，L4 结构信号 ${p.depth_signal_level_distribution.L4} 条。`);
  md.push(`- **人工待评队列**：${main.review_queue_size}/${main.n} 条，优先级 P0(陷阱) > P1(诊断) > P2(讲解)，队列已写入同批 JSON。`);
  md.push('- `可操作改错` / `解释「为什么」` 的低命中率首先应怀疑词表过窄，**不得**直接读作模型质量差；须用人工盲评样本校准词表。');
}

md.push('\n## 6. 复现');
md.push('\n```bash');
md.push('# 基线汇总');
md.push('node scripts/quality-baseline.mjs');
md.push('# 单份报告（含新增质量维度）');
md.push('node apps/api/src/tests/auto-eval.mjs --json reports/prompt-ab-8093-think-real-merged.json --set apps/api/src/tests/fixtures/prompt-ab-set-realexam.json');
md.push('# 单测');
md.push('node --test apps/api/src/tests/quality-rubric.test.mjs');
md.push('# 人工盲评（需 2 名评分人，50–100 条真实错题）');
md.push('npm run blind:export -- --from-json <报告.json> --raters 2 --seed 20261107');
md.push('npm run blind:score -- --key <key.json> --files <r1.csv>,<r2.csv>');
md.push('```');

if (errors.length) {
  md.push('\n## 7. 执行异常（如实记录）');
  for (const e of errors) md.push(`- ${e.spec}: ${e.error}`);
}

fs.writeFileSync(outMd, md.join('\n'), 'utf8');

console.log(`[quality-baseline] 报告 ${rows.length} 份，异常 ${errors.length} 份`);
console.log(`[quality-baseline] 人工盲评状态：${payload.human_review.status}`);
for (const row of rows) {
  const v = row.variants[0];
  if (!v) continue;
  const p = v.summary.proxies;
  console.log(`  ${row.label} / ${v.variant}: n=${v.n} 契约=${p.contract_complete.hits} 迁移=${p.transfer_hint.hits} 结构化ID=${p.structured_ids_present.hits} 深度目标未标定=${v.summary.depth_target_unspecified_count}`);
}
console.log(`[quality-baseline] JSON: ${path.relative(ROOT, outJson)}`);
console.log(`[quality-baseline] MD:   ${path.relative(ROOT, outMd)}`);
