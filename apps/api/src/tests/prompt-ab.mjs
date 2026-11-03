/**
 * K1.3 Prompt A/B 对比脚手架
 *
 * 为什么单独做一个 harness，而不是走 /attribution 接口：
 *  - 接口会写库、会跑 RAG + 联网检索，变量不止 Prompt 一个，无法归因到 Prompt 本身；
 *  - 这里直连 provider.chat()，输入只有 system prompt 不同，其他全等（同一题干、同一 tail、同一 maxTokens）。
 *
 * 用法：
 *   npm run prompt:ab                                   # 默认：mock + 全变体 + 全题（验证管道，秒级）
 *   npm run prompt:ab -- --provider real --limit 2      # 真模型跑前 2 题（慢，注意显存）
 *   npm run prompt:ab -- --variants v0.1,v0.1-strict --modes diagnose
 *
 * 参数：
 *   --set <path>        题目集（默认 tests/fixtures/prompt-ab-set.json）
 *   --variants a,b      变体（默认全部，见 promptVariants.ts）
 *   --modes diag,teach  只跑指定模式（默认沿用题目自带的 mode）
 *   --limit N           只跑前 N 题
 *   --ids m02,m05       只跑指定题号（盯单个失败案例时用）
 *   --provider mock|real  provider（默认 mock，便于秒级自检管道）
 *   --anchors             复现生产链路的知识锚点（grounding）注入：按题干/作答命中 references.ts 的 GOLD_REFERENCES 并拼到 system 尾部（默认关闭，保持"仅 Prompt 为变量"）
 *   --timeout ms        单次调用超时（默认 real=300000 / mock=10000）
 *   --tag <name>        报告文件名后缀
 *   --from-json <path>  不调模型，复用已有 JSON 结果重渲染报告（调报告逻辑时用）
 *
 * 产物：reports/prompt-ab-<ts>[-tag].md 与 .json（reports/ 已 gitignore）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SET_PATH = path.resolve(
  REPO_ROOT,
  args.set || 'apps/api/src/tests/fixtures/prompt-ab-set.json'
);
const USE_MOCK = (args.provider || 'mock') === 'mock';
const TAG = typeof args.tag === 'string' ? `-${args.tag}` : '';
const LIMIT = args.limit ? Number(args.limit) : Infinity;

/** 变体注册表（main 内动态 import 后赋给这个模块级引用，供 computeSummary 等复用） */
let VARIANTS = {};
const estTokens = (s) => Math.round((s || '').length / 1.6);

/**
 * 疑似空泛错因（启发式，仅作筛查信号，不作结论）
 *
 * 只看"出现了空泛词"会大量误杀（例如"导致 $z_y$ 计算错误"其实已点名具体对象）。
 * 因此判据是：命中空泛词 **且** 缺少任何具体性标记（LaTeX 公式 / 指名法则定理 / 步骤或端点等定位词）。
 */
const VAGUE_WORDS_RE = /粗心|笔误|计算错误|算错|概念不清|基础不牢|思路不对|不熟练|审题不清|不够细心/;
const SPECIFIC_RE =
  /\$[^$]+\$|法则|公式|定理|定义|条件|前提|链式|洛必达|换元|上下限|系数|符号|约分|端点|单调|收敛|发散|可导|偏导|导数|积分|行列式|判别式/;

function isVagueCause(cause) {
  if (!cause) return false;
  return VAGUE_WORDS_RE.test(cause) && !SPECIFIC_RE.test(cause);
}

/** 简易归一化：去空白、标点、全角符号，用于跨变体对比 */
const norm = (s) =>
  (s || '')
    .replace(/\s+/g, '')
    .replace(/[，。；：、,.;:!?！？"'"'（）()【】\[\]]/g, '')
    .toLowerCase();

function similarity(a, b) {
  const A = norm(a);
  const B = norm(b);
  if (!A && !B) return 1;
  if (!A || !B) return 0;
  if (A === B) return 1;
  // 2-gram Jaccard，足够看出"是否在讲同一件事"
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(A);
  const gb = grams(B);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 取多行文本的最后一行（推导的收尾等式通常在末尾） */
function lastLine(s) {
  const ls = String(s || '')
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return ls.length ? ls[ls.length - 1] : '';
}

/**
 * 讲解模式自查：`正确答案` 是否被 `正确推导` 的最后一步支持。
 *
 * 动机：第一轮 m05 出现过"正确答案写 $-\frac{1}{e^{y+az}}$，推导里却是 $-\frac{1}{ae^{y+az}}$"的
 * 自相矛盾——格式合规、内容错误，机器指标全绿。这里只做**筛查信号**（低相似度需人工看），
 * 不作判定：答案写成简写、推导末行为中间步骤时也可能低分。
 */
const SELF_INCONSISTENT_THRESHOLD = 0.3;
function answerDerivationSimilarity(parsed) {
  const ans = parsed?.correct_answer || '';
  const der = parsed?.derivation || '';
  if (!ans || !der) return null;
  return +similarity(ans, lastLine(der)).toFixed(2);
}

async function main() {
  const fsMod = fs;
  if (!fsMod.existsSync(SET_PATH)) {
    console.error(`[ab] 题目集不存在：${SET_PATH}`);
    process.exit(2);
  }
  const setDoc = JSON.parse(fsMod.readFileSync(SET_PATH, 'utf8'));
  let cases = Array.isArray(setDoc.cases) ? setDoc.cases : [];
  if (args.ids) {
    const ids = String(args.ids)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    cases = cases.filter((c) => ids.includes(c.id));
  }
  if (Number.isFinite(LIMIT)) cases = cases.slice(0, LIMIT);

  const { PROMPT_VARIANTS, resolvePrompt } = await import(
    '../services/attribution/promptVariants.js'
  );
  VARIANTS = PROMPT_VARIANTS;
  // --anchors：复现生产链路的知识锚点（grounding）注入，仅作验证用。
  // 生产里 attributionService 把 getKnowledgeReferences 拼到 system 尾部；
  // 这里开启后对每个 case 同样注入，从而能在 harness 里验证锚点对 re03 类题目的修复。
  const USE_ANCHORS = Boolean(args.anchors);
  const { parseAttrTriple, parseTeaching } = await import('../services/attribution/prompt.js');
  const { getKnowledgeReferences } = await import('../services/attribution/references.js');
  const { withTimeout } = await import('../utils/promise.js');
  const { MockProvider } = await import('../services/llm/mockProvider.js');

  const variantIds = args.variants
    ? String(args.variants)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : Object.keys(PROMPT_VARIANTS);
  // 提前校验变体 id，避免跑到一半才发现拼错
  for (const id of variantIds) resolvePrompt(id, 'diagnose');

  // --from-json：复用已有结果重渲染报告（调报告/启发式逻辑时不烧模型时间）
  if (args['from-json']) {
    const src = path.resolve(REPO_ROOT, String(args['from-json']));
    if (!fsMod.existsSync(src)) {
      console.error(`[ab] 结果文件不存在：${src}`);
      process.exit(2);
    }
    const prev = JSON.parse(fsMod.readFileSync(src, 'utf8'));
    const results = (prev.results || []).map((r) => ({
      ...r,
      ok: r.mode === 'diagnose' ? Boolean(r.fields?.hasThree) : Boolean(r.fields?.hasCore),
      vague_cause: r.mode === 'diagnose' ? isVagueCause(r.fields?.cause) : null,
      answer_derivation_similarity:
        r.mode === 'teach' ? answerDerivationSimilarity(r.fields) : null,
      answer_unsupported:
        r.mode === 'teach'
          ? (() => {
              const s = answerDerivationSimilarity(r.fields);
              return s === null ? null : s < SELF_INCONSISTENT_THRESHOLD;
            })()
          : null,
    }));
    console.log(`[ab] 复用结果重渲染：${path.relative(REPO_ROOT, src)}（${results.length} 条）`);
    emitReport({
      results,
      summary: computeSummary(results),
      caseDiffs: computeCaseDiffs(results),
      providerName: `${prev.provider} (re-rendered)`,
      timeoutMs: prev.timeout_ms,
      variantIds: prev.variants || variantIds,
      cases,
      setDoc: { ...setDoc, version: prev.set_version ?? setDoc.version },
      tag: TAG || '-rerender',
      outDirArg: args.out,
    });
    return;
  }

  const modesFilter = args.modes
    ? String(args.modes)
        .split(',')
        .map((s) => s.trim())
    : null;

  let provider;
  if (USE_MOCK) {
    provider = new MockProvider();
  } else {
    const { initProvider, getAnalysisProvider } = await import('../services/llm/index.js');
    await initProvider();
    provider = getAnalysisProvider();
  }

  const timeoutMs = args.timeout
    ? Number(args.timeout)
    : USE_MOCK
      ? 10000
      : 300000;

  console.log(
    `[ab] provider=${provider.name} timeout=${timeoutMs}ms cases=${cases.length} variants=${variantIds.join('/')}`
  );

  const results = [];
  let seq = 0;
  const total = cases.length * variantIds.length;

  for (const c of cases) {
    const mode = c.mode === 'teach' ? 'teach' : 'diagnose';
    if (modesFilter && !modesFilter.includes(mode) && !modesFilter.includes(c.mode)) continue;

    for (const vid of variantIds) {
      seq++;
      const p = resolvePrompt(vid, mode);
      const ansPart =
        mode === 'diagnose' && c.user_answer ? `\n用户作答：${String(c.user_answer).trim()}` : '';
      // 复现生产：把命中的知识锚点拼到 system 尾部（与生产 attributionService 一致）。
      const anchorText = USE_ANCHORS
        ? getKnowledgeReferences(
            String(c.question),
            c.user_answer ? String(c.user_answer) : undefined,
            c.subject
          ).join('\n\n')
        : '';
      const systemContent = anchorText
        ? `${p.system}\n\n【知识锚点（仅供你参考 grounding，不要原样复述，也不计入最终三行结论）】\n${anchorText}`
        : p.system;
      const userContent = `题干：\n${String(c.question).trim()}${ansPart}\n${p.tail}`;
      const messages = [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent },
      ];

      const started = Date.now();
      let text = '';
      let err = null;
      let latencyMs = 0;
      try {
        const r = await withTimeout(
          provider.chat(messages, {
            maxTokens: p.maxTokens,
            temperature: 0.2,
          }),
          timeoutMs
        );
        text = r.text || '';
        latencyMs = r.latencyMs ?? Date.now() - started;
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
        latencyMs = Date.now() - started;
      }

      const parsed =
        mode === 'diagnose' ? parseAttrTriple(text) : parseTeaching(text);
      const ok = mode === 'diagnose' ? Boolean(parsed.hasThree) : Boolean(parsed.hasCore);
      const cause = mode === 'diagnose' ? parsed.cause : undefined;
      const kp = parsed.knowledge_point;
      const ansSim = mode === 'teach' ? answerDerivationSimilarity(parsed) : null;

      results.push({
        case_id: c.id,
        mode,
        difficulty: c.difficulty ?? '',
        subject: c.subject ?? '',
        trap: Boolean(c.trap),
        variant: vid,
        ok,
        err,
        latency_ms: latencyMs,
        chars: text.length,
        est_tokens: estTokens(text),
        has_latex: /\$[^$]+\$/.test(text),
        vague_cause: mode === 'diagnose' ? isVagueCause(cause) : null,
        answer_derivation_similarity: ansSim,
        answer_unsupported: ansSim !== null ? ansSim < SELF_INCONSISTENT_THRESHOLD : null,
        fields: parsed,
        text,
      });

      const mark = err ? 'ERR' : ok ? 'OK ' : 'BAD';
      console.log(
        `[ab] ${String(seq).padStart(2)}/${total} ${c.id} ${mode.padEnd(8)} ${vid.padEnd(12)} ${mark} ${(latencyMs / 1000).toFixed(1)}s ${text.length}ch`
      );
    }
  }

  // ---------- 汇总统计 ----------
  const summary = computeSummary(results);
  const caseDiffs = computeCaseDiffs(results);

  // ---------- 落盘 ----------
  emitReport({
    results,
    summary,
    caseDiffs,
    providerName: provider.name,
    timeoutMs,
    variantIds,
    cases,
    setDoc,
    tag: TAG,
    outDirArg: args.out,
  });
}

/** 汇总：每变体合规率 / 耗时 / 字数 / LaTeX 覆盖 / 疑似空泛错因率 */
function computeSummary(results) {
  const byVariant = new Map();
  for (const r of results) {
    const s = byVariant.get(r.variant) ?? {
      variant: r.variant,
      n: 0,
      ok: 0,
      latency: [],
      chars: [],
      latex: 0,
      vague: 0,
      vagueN: 0,
      unsupported: 0,
      unsupportedN: 0,
      trapN: 0,
    };
    s.n++;
    if (r.ok) s.ok++;
    s.latency.push(r.latency_ms);
    s.chars.push(r.chars);
    if (r.has_latex) s.latex++;
    if (r.vague_cause !== null) {
      s.vagueN++;
      if (r.vague_cause) s.vague++;
    }
    if (r.answer_unsupported !== null && r.answer_unsupported !== undefined) {
      s.unsupportedN++;
      if (r.answer_unsupported) s.unsupported++;
    }
    if (r.trap) s.trapN++;
    byVariant.set(r.variant, s);
  }
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  return [...byVariant.values()].map((s) => ({
    variant: s.variant,
    label: VARIANTS[s.variant]?.label ?? '',
    hypothesis: VARIANTS[s.variant]?.hypothesis ?? '',
    n: s.n,
    ok: s.ok,
    trap_n: s.trapN,
    compliance: s.n ? s.ok / s.n : 0,
    avg_latency_s: +(avg(s.latency) / 1000).toFixed(1),
    avg_chars: Math.round(avg(s.chars)),
    latex_rate: s.n ? s.latex / s.n : 0,
    vague_rate: s.vagueN ? s.vague / s.vagueN : null,
    unsupported_rate: s.unsupportedN ? s.unsupported / s.unsupportedN : null,
  }));
}

/** 逐题跨变体差异（相对该题第一个变体） */
function computeCaseDiffs(results) {
  const byCase = new Map();
  for (const r of results) {
    if (!byCase.has(r.case_id)) byCase.set(r.case_id, []);
    byCase.get(r.case_id).push(r);
  }
  const caseDiffs = [];
  for (const [cid, rs] of byCase) {
    if (rs.length < 2) continue;
    const base = rs[0];
    for (let i = 1; i < rs.length; i++) {
      const other = rs[i];
      caseDiffs.push({
        case_id: cid,
        mode: base.mode,
        a: base.variant,
        b: other.variant,
        kp_similarity: +similarity(base.fields.knowledge_point, other.fields.knowledge_point).toFixed(2),
        cause_similarity:
          base.mode === 'diagnose'
            ? +similarity(base.fields.cause, other.fields.cause).toFixed(2)
            : null,
      });
    }
  }
  return caseDiffs;
}

/** 写 md + json 并打印汇总 */
function emitReport({
  results,
  summary,
  caseDiffs,
  providerName,
  timeoutMs,
  variantIds,
  cases,
  setDoc,
  tag,
  outDirArg,
}) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(REPO_ROOT, outDirArg || 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const baseName = `prompt-ab-${ts}${tag || ''}`;
  const jsonPath = path.join(outDir, `${baseName}.json`);
  const mdPath = path.join(outDir, `${baseName}.md`);

  const payload = {
    generated_at: new Date().toISOString(),
    set: path.relative(REPO_ROOT, SET_PATH),
    set_version: setDoc.version ?? '',
    provider: providerName,
    timeout_ms: timeoutMs,
    variants: variantIds,
    summary,
    case_diffs: caseDiffs,
    results,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(mdPath, renderMarkdown(payload, cases, variantIds), 'utf8');

  console.log('\n[ab] 汇总');
  for (const s of summary) {
    console.log(
      `  ${s.variant.padEnd(12)} 合规 ${(s.compliance * 100).toFixed(0)}%  平均 ${s.avg_latency_s}s  ${s.avg_chars}字  LaTeX ${(s.latex_rate * 100).toFixed(0)}%  疑似空泛 ${s.vague_rate === null ? '-' : (s.vague_rate * 100).toFixed(0) + '%'}`
    );
  }
  console.log(`\n[ab] 报告：${path.relative(REPO_ROOT, mdPath)}`);
  console.log(`[ab] 数据：${path.relative(REPO_ROOT, jsonPath)}`);
}

function renderMarkdown(payload, cases, variantIds) {
  const L = [];
  L.push(`# Prompt A/B 报告（${payload.generated_at}）`);
  L.push('');
  L.push(`- 题目集：\`${payload.set}\`（version=${payload.set_version}）`);
  L.push(`- provider：**${payload.provider}**，单次超时 ${payload.timeout_ms}ms`);
  L.push(`- 变体：${variantIds.map((v) => `\`${v}\``).join(' / ')}`);
  L.push('');
  L.push('> 判读方式：**先看合规率**（输出不可解析的变体直接淘汰），再看空泛标签率，最后人工读「逐题对照」判是否真触及本质。耗时只作参考，不作优劣依据。');
  L.push('');
  L.push('## 汇总');
  L.push('');
  L.push('| 变体 | 说明 | 验证假设 | 合规率 | 平均耗时 | 平均字数 | LaTeX 覆盖 | 疑似空泛错因率 | 答案-推导不自洽率 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const s of payload.summary) {
    L.push(
      `| \`${s.variant}\` | ${s.label} | ${s.hypothesis} | ${(s.compliance * 100).toFixed(0)}% (${Math.round(s.compliance * s.n)}/${s.n}) | ${s.avg_latency_s}s | ${s.avg_chars} | ${(s.latex_rate * 100).toFixed(0)}% | ${s.vague_rate === null ? '—' : (s.vague_rate * 100).toFixed(0) + '%'} | ${s.unsupported_rate === null || s.unsupported_rate === undefined ? '—' : (s.unsupported_rate * 100).toFixed(0) + '%'} |`
    );
  }
  L.push('');
  L.push('> 「答案-推导不自洽率」是筛查信号，不是判错：计算 `正确答案` 与 `正确推导` 末行的 2-gram 相似度，<0.30 视为可疑。它只能抓"答案与自己的推导对不上"，抓不到"两处都错但彼此一致"，所以仍需人工核对。');
  if (payload.case_diffs.length) {
    L.push('### 跨变体一致性（2-gram Jaccard，1.00=表述完全一致）');
    L.push('');
    L.push('| 题 | 模式 | A | B | 知识点相似度 | 错因相似度 |');
    L.push('|---|---|---|---|---|---|');
    for (const d of payload.case_diffs) {
      L.push(
        `| ${d.case_id} | ${d.mode} | \`${d.a}\` | \`${d.b}\` | ${d.kp_similarity} | ${d.cause_similarity === null ? '—' : d.cause_similarity} |`
      );
    }
    L.push('');
    L.push('> 相似度低≠错。低相似度只说明"变体确实改变了模型判断"，需人工判哪个更好；相似度高则说明该题上 Prompt 不敏感，可从盲评集中剔除以节省专家工时。');
    L.push('');
  }

  L.push('## 逐题对照');
  L.push('');
  for (const c of cases) {
    const rs = payload.results.filter((r) => r.case_id === c.id);
    if (!rs.length) continue;
    L.push(`### ${c.id} · ${rs[0].mode} · ${c.difficulty || '-'}${c.trap ? ' · ⚠️ 陷阱题（作答本身正确）' : ''}`);
    L.push('');
    L.push(`**题干**：${String(c.question).replace(/\n/g, ' ')}`);
    L.push('');
    if (c.user_answer) {
      L.push(`**用户作答**：${String(c.user_answer).replace(/\n/g, ' ')}`);
      L.push('');
    }
    for (const r of rs) {
      const status = r.err ? `❌ 异常：${r.err}` : r.ok ? '✅ 合规' : '⚠️ 不合规（解析缺项）';
      L.push(`<details><summary><code>${r.variant}</code> — ${status} · ${(r.latency_ms / 1000).toFixed(1)}s · ${r.chars} 字</summary>`);
      L.push('');
      L.push('```text');
      L.push(r.text.trim() || '(空输出)');
      L.push('```');
      L.push('');
      L.push('</details>');
      L.push('');
    }
  }

  L.push('---');
  L.push('');
  L.push('## 下一步（K1.3 收口）');
  L.push('');
  L.push('1. 在上述对照里挑出"明显更好"的变体，只保留 2 个进盲评，减少专家工作量；');
  L.push('2. 用 50–100 条真实错题跑最终 2 个变体，导出盲评表（隐藏变体名，随机左右）；');
  L.push('3. 专家按「是否触及本质 / 是否可直接指导改错」打分，填入题目集的 `expert_ref`；');
  L.push('4. 认可率≥70% 方可提升候选为线上 `ATTR_SYSTEM`，并同步 bump `kq_taxonomy_version`。');
  L.push('');
  return L.join('\n');
}

main().catch((e) => {
  console.error('[ab] 运行异常', e);
  process.exit(1);
});
