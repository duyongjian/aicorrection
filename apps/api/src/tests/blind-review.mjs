/**
 * K1.3 盲评表导出 / 计分
 *
 * 为什么需要这个脚本：
 *  - prompt-ab 的报告是"技术对照"，作者知道哪一列是哪个变体，天然有确认偏误；
 *  - G1 闸门要的是"用户/专家在不知道版本的前提下是否认可"，必须做盲评；
 *  - 第一轮已证明「合规率 ≠ 质量」「模型会把正确作答强行归因」，所以评分表必须把
 *    「错因方向是否正确」与「是否触及本质」拆开，避免"具体但错误"的错因被高分放过。
 *
 * 子命令：
 *   npm run blind:export -- --from-json reports/prompt-ab-xxx.json [--raters 2] [--seed 20261103]
 *   npm run blind:score  -- --key reports/blind-xxx-key.json --files r1.csv,r2.csv
 *
 * 产物（reports/ 已 gitignore）：
 *   blind-<ts>-阅读材料.md     给评分人看（隐藏变体名，A/B 顺序逐题随机）
 *   blind-<ts>-评分表-r1.csv   给评分人填（UTF-8 BOM，Excel 直接打开不乱码）
 *   blind-<ts>-key.json        【不可给评分人】A/B → 变体映射 + 人工正解
 *   blind-<ts>-内部对照.md      【不可给评分人】带变体名与 provisional_truth 的对照
 *   blind-<ts>-计分.md/.json    score 子命令产出
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const DIRECTION = ['对', '错', '无法判断'];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** mulberry32：可复现的伪随机，保证同 seed 下 A/B 顺序一致，便于复核 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** RFC4180 风格：双引号包裹、内部双引号翻倍 */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 逐字符解析（处理引号内换行），返回 string[][] */
function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (ch === '\r') {
      // 忽略，兼容 CRLF
    } else cur += ch;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Cohen's kappa（两评分者、名义量表） */
function cohenKappa(pairs, categories) {
  const n = pairs.length;
  if (!n) return null;
  const idx = new Map(categories.map((c, i) => [c, i]));
  const k = categories.length;
  const m = Array.from({ length: k }, () => Array(k).fill(0));
  let agree = 0;
  for (const [a, b] of pairs) {
    const ia = idx.get(a);
    const ib = idx.get(b);
    if (ia === undefined || ib === undefined) continue;
    m[ia][ib]++;
    if (ia === ib) agree++;
  }
  const rowSum = m.map((r) => r.reduce((x, y) => x + y, 0));
  const colSum = m.map((_, j) => m.reduce((s, r) => s + r[j], 0));
  const pe = rowSum.reduce((s, rs, i) => s + (rs / n) * (colSum[i] / n), 0);
  if (pe === 1) return 1;
  return (agree / n - pe) / (1 - pe);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (x) => (x === null ? '—' : `${(x * 100).toFixed(0)}%`);
const num = (x, d = 2) => (x === null ? '—' : x.toFixed(d));

// ---------------------------------------------------------------- export
function doExport(args) {
  const src = path.resolve(REPO_ROOT, String(args['from-json'] || ''));
  if (!args['from-json'] || !fs.existsSync(src)) {
    console.error('[blind] 需要 --from-json <prompt-ab 结果 json>');
    process.exit(2);
  }
  const run = JSON.parse(fs.readFileSync(src, 'utf8'));
  const results = Array.isArray(run.results) ? run.results : [];
  if (!results.length) {
    console.error('[blind] 结果为空，无法导出');
    process.exit(2);
  }

  // 题集：优先用 --set，否则从 run.set 反查
  const setPath = path.resolve(
    REPO_ROOT,
    args.set || run.set || 'apps/api/src/tests/fixtures/prompt-ab-set.json'
  );
  const setDoc = fs.existsSync(setPath) ? JSON.parse(fs.readFileSync(setPath, 'utf8')) : { cases: [] };
  const caseMap = new Map((setDoc.cases || []).map((c) => [c.id, c]));

  const raters = Math.max(1, Number(args.raters || 1));
  const seed = Number(args.seed || 20261103);

  // 按题聚合；每题的变体顺序每份评分表独立随机（不同评分者不共享顺序）
  const byCase = new Map();
  for (const r of results) {
    if (!byCase.has(r.case_id)) byCase.set(r.case_id, []);
    byCase.get(r.case_id).push(r);
  }
  const usable = [...byCase.entries()].filter(([, rs]) => rs.length >= 2);
  const skipped = [...byCase.entries()].filter(([, rs]) => rs.length < 2).map(([id]) => id);
  if (!usable.length) {
    console.error('[blind] 没有"同一题 ≥2 个变体"的结果，无法做盲评对照');
    process.exit(2);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(REPO_ROOT, args.out || 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const base = `blind-${ts}`;

  const key = {
    generated_at: new Date().toISOString(),
    source: path.relative(REPO_ROOT, src),
    seed,
    raters: [],
    items: [],
    note:
      '本文件含变体真实身份与人工正解，禁止发给评分人。评分表里的 A/B 为随机顺序，逐份评分表各自独立随机。',
  };

  const raterDocs = Array.from({ length: raters }, (_, i) => ({
    id: `r${i + 1}`,
    rows: [],
    rnd: mulberry32(seed + i * 7919),
  }));

  // 逐题分配 A/B，并为每份评分表生成顺序
  const itemDefs = usable.map(([cid, rs], idx) => {
    const c = caseMap.get(cid) || {};
    const mode = rs[0].mode;
    const subject = c.subject || rs[0].subject || '';
    // 用固定随机源决定该题在两份表中共享的"A 组/B 组"（保证同一题在不同评分者间可比）
    return { row: idx + 1, cid, rs, c, mode, subject };
  });

  for (const def of itemDefs) {
    // 该题 A/B 归属只随机一次，所有评分者看到相同的 A/B 内容（分数才可跨评分者比较）
    const pick = shuffle(def.rs, mulberry32(seed + def.row * 104729));
    const a = pick[0];
    const b = pick[1];
    key.items.push({
      row: def.row,
      case_id: def.cid,
      subject: def.subject,
      mode: def.mode,
      trap: Boolean(def.c && def.c.trap),
      label_a_variant: a.variant,
      label_b_variant: b.variant,
      provisional_truth: def.c.provisional_truth || null,
      a_ok_parse: Boolean(a.ok),
      b_ok_parse: Boolean(b.ok),
    });
    def.a = a;
    def.b = b;
  }

  // 每份评分表打乱题序，降低"同一题相邻对照"的锚定效应
  for (const rd of raterDocs) {
    const order = shuffle(itemDefs, rd.rnd);
    key.raters.push({ id: rd.id, order: order.map((d) => ({ row: d.row, case_id: d.cid })) });
    rd.rows = order;
  }

  // ---- key.json
  const keyPath = path.join(outDir, `${base}-key.json`);
  fs.writeFileSync(keyPath, JSON.stringify(key, null, 2), 'utf8');

  // ---- 阅读材料.md（按各评分表的题序各出一份，内容相同顺序不同）
  for (const rd of raterDocs) {
    const L = [];
    L.push(`# 归因结果盲评 · 阅读材料（${rd.id}）`);
    L.push('');
    L.push(`> 共 ${rd.rows.length} 题，每题给出两版 AI 输出（A / B），**同一题的两版仅 Prompt 不同**。`);
    L.push('> 请**先独立看题干与作答、自己心里有数**，再看输出，避免被措辞带走。');
    L.push('> 本材料**故意不提供参考答案**，若你认为题干信息不足以判断，请在该题"备注"里写明。');
    L.push('');
    L.push('## 评分口径（请严格按此填表）');
    L.push('');
    L.push('**诊断类题（有学生作答）**');
    L.push('1. `错因方向是否正确`：AI 指出的错误根源，与学生**真正**犯的错是否一致。');
    L.push('   - 对：指向真实错因（哪怕措辞不同）');
    L.push('   - 错：指向了不存在的错 / 指错了原因 / **学生本来做对了却硬编错因**');
    L.push('   - 无法判断：题干信息不足');
    L.push('2. `是否触及本质`（1–5）：是否讲清了"为什么错"，5=触及原理，1=只给"粗心/不熟"这类空标签。');
    L.push('3. `能否指导改错`（1–5）：学生照这条反馈能否直接改对，5=能，1=不能。');
    L.push('');
    L.push('**讲解类题（无学生作答）**');
    L.push('1. `答案正确性`：AI 给出的正确答案/关键结论是否正确。**请自己先算一遍再看**。');
    L.push('2. `是否触及本质`（1–5）、`能否指导改错`（1–5）：同上。');
    L.push('');
    L.push('> ⚠️ 注意：**输出可读、格式漂亮 ≠ 正确**。上一轮已发现"错因写得很具体但指错了方向"比"写得很笼统"危害更大。');
    L.push('');
    L.push('---');
    L.push('');
    for (const d of rd.rows) {
      L.push(`## 第 ${d.row} 题 · ${d.cid} · ${d.subject} · ${d.mode === 'teach' ? '讲解类' : '诊断类'}`);
      L.push('');
      L.push(`**题干**：`);
      L.push('');
      L.push(String(d.c.question || '').trim() || '(缺失)');
      L.push('');
      if (d.mode !== 'teach' && d.c.user_answer) {
        L.push(`**学生作答**：`);
        L.push('');
        L.push(String(d.c.user_answer).trim());
        L.push('');
      }
      for (const [label, r] of [
        ['A', d.a],
        ['B', d.b],
      ]) {
        L.push(`**输出 ${label}**${r.err ? '（本次调用异常/超时，无有效输出）' : ''}：`);
        L.push('');
        L.push('```text');
        L.push((r.text || '').trim() || '(无输出)');
        L.push('```');
        L.push('');
      }
      L.push('---');
      L.push('');
    }
    fs.writeFileSync(path.join(outDir, `${base}-阅读材料-${rd.id}.md`), L.join('\n'), 'utf8');
  }

  // ---- 评分表 csv（每份评分者一份，题序独立）
  for (const rd of raterDocs) {
    const header = [
      '序号',
      '题号',
      '学科',
      '类型',
      'A_错因或答案是否正确(对/错/无法判断)',
      'A_是否触及本质(1-5)',
      'A_能否指导改错(1-5)',
      'B_错因或答案是否正确(对/错/无法判断)',
      'B_是否触及本质(1-5)',
      'B_能否指导改错(1-5)',
      '更愿意相信哪一版(A/B/持平)',
      '备注',
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const d of rd.rows) {
      lines.push(
        [
          d.row,
          d.cid,
          d.subject,
          d.mode === 'teach' ? '讲解' : '诊断',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ]
          .map(csvCell)
          .join(',')
      );
    }
    fs.writeFileSync(
      path.join(outDir, `${base}-评分表-${rd.id}.csv`),
      '\uFEFF' + lines.join('\r\n') + '\r\n',
      'utf8'
    );
  }

  // ---- 内部对照.md（带变体名与人工正解，仅供内部）
  {
    const L = [];
    L.push(`# 内部对照（禁止发给评分人）· ${ts}`);
    L.push('');
    L.push(`- 来源：\`${path.relative(REPO_ROOT, src)}\``);
    L.push(`- 变体：${(run.variants || []).map((v) => `\`${v}\``).join(' / ')}`);
    L.push(`- 随机种子：${seed}（A/B 归属与题序均可复现）`);
    L.push('');
    L.push('| 序 | 题 | 学科 | 模式 | A = | B = | 陷阱题 | 人工正解要点 |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const it of key.items) {
      L.push(
        `| ${it.row} | ${it.case_id} | ${it.subject} | ${it.mode} | \`${it.label_a_variant}\` | \`${it.label_b_variant}\` | ${it.trap ? '是' : '—'} | ${(it.provisional_truth || '').replace(/\|/g, '\\|').slice(0, 90)} |`
      );
    }
    L.push('');
    fs.writeFileSync(path.join(outDir, `${base}-内部对照.md`), L.join('\n'), 'utf8');
  }

  console.log(`[blind] 导出 ${itemDefs.length} 题 × 2 版，评分表 ${raters} 份`);
  if (skipped.length) console.log(`[blind] 跳过（该题仅有 1 个变体结果）：${skipped.join(',')}`);
  console.log(`[blind] 阅读材料：reports/${base}-阅读材料-r1.md …`);
  console.log(`[blind] 评分表  ：reports/${base}-评分表-r1.csv …`);
  console.log(`[blind] 密钥/正解：reports/${base}-key.json（勿外发）`);
  console.log(`[blind] 内部对照：reports/${base}-内部对照.md（勿外发）`);
}

// ---------------------------------------------------------------- score
function doScore(args) {
  if (!args.key || !args.files) {
    console.error('[blind] 需要 --key <key.json> --files <r1.csv,r2.csv>');
    process.exit(2);
  }
  const keyPath = path.resolve(REPO_ROOT, String(args.key));
  const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  const byRow = new Map(key.items.map((it) => [it.row, it]));

  const files = String(args.files)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  /** raterData: [{rater, entries: Map<row, {aDir,bDir,aEss,bEss,aGuide,bGuide,pref,note}>}] */
  const raterData = [];
  const problems = [];

  for (const f of files) {
    const p = path.resolve(REPO_ROOT, f);
    if (!fs.existsSync(p)) {
      problems.push(`文件不存在：${f}`);
      continue;
    }
    const rows = parseCsv(fs.readFileSync(p, 'utf8'));
    if (rows.length < 2) {
      problems.push(`文件无数据：${f}`);
      continue;
    }
    const head = rows[0].map((h) => h.trim());
    const col = (needle) => head.findIndex((h) => h.includes(needle));
    const iRow = col('序号');
    const iADir = col('A_错因或答案');
    const iAEss = col('A_是否触及本质');
    const iAGuide = col('A_能否指导改错');
    const iBDir = col('B_错因或答案');
    const iBEss = col('B_是否触及本质');
    const iBGuide = col('B_能否指导改错');
    const iPref = col('更愿意相信');
    const iNote = col('备注');
    if ([iRow, iADir, iAEss, iBDir, iBEss].some((i) => i < 0)) {
      problems.push(`表头缺列：${f}`);
      continue;
    }
    const entries = new Map();
    let empty = 0;
    for (const r of rows.slice(1)) {
      const row = Number(String(r[iRow] || '').trim());
      if (!Number.isFinite(row) || !byRow.has(row)) continue;
      const dir = (i) => {
        const v = String(r[i] || '').trim();
        return DIRECTION.includes(v) ? v : null;
      };
      const sc = (i) => {
        const v = Number(String(r[i] || '').trim());
        return Number.isFinite(v) && v >= 1 && v <= 5 ? v : null;
      };
      const e = {
        aDir: dir(iADir),
        bDir: dir(iBDir),
        aEss: sc(iAEss),
        bEss: sc(iBEss),
        aGuide: iAGuide >= 0 ? sc(iAGuide) : null,
        bGuide: iBGuide >= 0 ? sc(iBGuide) : null,
        pref: iPref >= 0 ? String(r[iPref] || '').trim().toUpperCase() : '',
        note: iNote >= 0 ? String(r[iNote] || '').trim() : '',
      };
      if (!e.aDir && !e.bDir) empty++;
      entries.set(row, e);
    }
    if (empty) problems.push(`${path.basename(f)}：${empty} 题未填「对/错/无法判断」`);
    raterData.push({ rater: path.basename(f), entries });
  }

  if (!raterData.length) {
    console.error('[blind] 没有可解析的评分表：\n' + problems.join('\n'));
    process.exit(2);
  }

  // 按变体聚合
  const agg = new Map();
  const bump = (vid) => {
    if (!agg.has(vid)) {
      agg.set(vid, {
        variant: vid,
        dirOk: 0,
        dirN: 0,
        dirWrong: 0,
        ess: [],
        guide: [],
        trapDirOk: 0,
        trapN: 0,
        wins: 0,
        losses: 0,
        ties: 0,
      });
    }
    return agg.get(vid);
  };

  for (const rd of raterData) {
    for (const [row, e] of rd.entries) {
      const it = byRow.get(row);
      if (!it) continue;
      for (const [label, dir, ess, guide] of [
        ['a', e.aDir, e.aEss, e.aGuide],
        ['b', e.bDir, e.bEss, e.bGuide],
      ]) {
        const vid = label === 'a' ? it.label_a_variant : it.label_b_variant;
        const s = bump(vid);
        if (dir === '对' || dir === '错') {
          s.dirN++;
          if (dir === '对') {
            s.dirOk++;
            if (it.trap) s.trapDirOk++;
          } else s.dirWrong++;
        }
        if (it.trap && dir === '对') s.trapN++;
        else if (it.trap && dir === '错') s.trapN++;
        if (ess !== null) s.ess.push(ess);
        if (guide !== null) s.guide.push(guide);
      }
      // 偏好：显式填写优先，否则按 (方向对 > 方向错, 本质分高) 推导
      const vote = (() => {
        if (e.pref === 'A') return 'a';
        if (e.pref === 'B') return 'b';
        if (e.pref === '持平' || e.pref === 'TIE') return 'tie';
        if (e.aDir === '对' && e.bDir !== '对') return 'a';
        if (e.bDir === '对' && e.aDir !== '对') return 'b';
        if (e.aEss !== null && e.bEss !== null && e.aEss !== e.bEss) return e.aEss > e.bEss ? 'a' : 'b';
        return 'tie';
      })();
      const va = bump(it.label_a_variant);
      const vb = bump(it.label_b_variant);
      if (vote === 'a') {
        va.wins++;
        vb.losses++;
      } else if (vote === 'b') {
        vb.wins++;
        va.losses++;
      } else {
        va.ties++;
        vb.ties++;
      }
    }
  }

  // 评分者间一致性
  let kappaDirection = null;
  let prefAgree = null;
  const prefPairs = [];
  const dirPairs = [];
  let prefAgreeN = 0;
  if (raterData.length >= 2) {
    const [r1, r2] = raterData;
    for (const [row, e1] of r1.entries) {
      const e2 = r2.entries.get(row);
      if (!e2) continue;
      const it = byRow.get(row);
      if (!it) continue;
      const map = (e) =>
        e.pref === 'A'
          ? 'a'
          : e.pref === 'B'
            ? 'b'
            : e.aDir === '对' && e.bDir !== '对'
              ? 'a'
              : e.bDir === '对' && e.aDir !== '对'
                ? 'b'
                : 'tie';
      prefPairs.push([map(e1), map(e2)]);
      if (e1.aDir && e2.aDir) dirPairs.push([e1.aDir, e2.aDir]);
      if (e1.bDir && e2.bDir) dirPairs.push([e1.bDir, e2.bDir]);
      prefAgreeN++;
    }
    kappaDirection = cohenKappa(dirPairs, DIRECTION);
    const agree = prefPairs.filter(([x, y]) => x === y).length;
    prefAgree = prefPairs.length ? agree / prefPairs.length : null;
  }

  const rowsOut = [...agg.values()]
    .map((s) => ({
      variant: s.variant,
      n_judged: s.dirN,
      direction_ok_rate: s.dirN ? s.dirOk / s.dirN : null,
      direction_wrong: s.dirWrong,
      trap_ok_rate: s.trapN ? s.trapDirOk / s.trapN : null,
      essence_mean: mean(s.ess),
      guide_mean: mean(s.guide),
      wins: s.wins,
      losses: s.losses,
      ties: s.ties,
    }))
    .sort((a, b) => (b.direction_ok_rate ?? -1) - (a.direction_ok_rate ?? -1));

  const outDir = path.dirname(keyPath);
  const base = path.basename(keyPath).replace(/-key\.json$/, '');
  const L = [];
  L.push(`# 盲评计分（${new Date().toISOString().slice(0, 19)}）`);
  L.push('');
  L.push(`- 密钥：\`${path.basename(keyPath)}\``);
  L.push(`- 评分表：${files.map((f) => `\`${f}\``).join('、')}`);
  L.push(`- 题目数：${key.items.length}；评分者：${raterData.length}`);
  L.push('');
  if (problems.length) {
    L.push('> ⚠️ 数据完整性提示');
    for (const p of problems) L.push(`> - ${p}`);
    L.push('');
  }
  L.push('## 分变体结果');
  L.push('');
  L.push('| 变体 | 有效判定数 | 错因/答案方向正确率 | 方向判错次数 | 陷阱题未瞎编率 | 触及本质均值 | 可指导改错均值 | 偏好胜/负/平 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const r of rowsOut) {
    L.push(
      `| \`${r.variant}\` | ${r.n_judged} | ${pct(r.direction_ok_rate)} | ${r.direction_wrong} | ${pct(r.trap_ok_rate)} | ${num(r.essence_mean)} | ${num(r.guide_mean)} | ${r.wins}/${r.losses}/${r.ties} |`
    );
  }
  L.push('');
  L.push('## 评分者间一致性');
  L.push('');
  L.push(`- 「方向是否正确」三分类 Cohen's κ：**${num(kappaDirection, 3)}**（>0.6 可接受，>0.8 良好，<0.4 说明口径需重训）`);
  L.push(`- 「更愿意相信哪一版」一致率：**${pct(prefAgree)}**（${prefAgreeN} 题可比）`);
  L.push('');
  L.push('## 判读建议');
  L.push('');
  L.push('1. **先看陷阱题列**。陷阱题（学生本来做对）上"未瞎编率"低于 80%，说明强行归因仍在发生，此时**任何认可率都不能进入 G1 闸门**。');
  L.push('2. **再看方向正确率**。它是 G1 认可率的分母保护：方向错但用户点了认可，会让闸门虚高。');
  L.push('3. **本质分/可指导分只在方向正确时才有意义**，不要单独拿均值排名。');
  L.push('4. κ < 0.4 时不应急着改 Prompt，先修评分口径（多数是"方向是否正确"与"是否触及本质"混淆）。');
  L.push('');
  L.push('> 提醒：盲评结论只用于**变体取舍**；G1 认可率必须由真实用户在真实闭环中产生（K1.4–K1.5）。');
  L.push('');

  const mdPath = path.join(outDir, `${base}-计分.md`);
  const jsonPath = path.join(outDir, `${base}-计分.json`);
  fs.writeFileSync(mdPath, L.join('\n'), 'utf8');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        key: path.basename(keyPath),
        files,
        variants: rowsOut,
        inter_rater: { cohen_kappa_direction: kappaDirection, preference_agreement: prefAgree, n: prefAgreeN },
        problems,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log('[blind] 分变体结果');
  for (const r of rowsOut) {
    console.log(
      `  ${r.variant.padEnd(14)} 方向 ${pct(r.direction_ok_rate).padStart(4)}  陷阱 ${pct(r.trap_ok_rate).padStart(4)}  本质 ${num(r.essence_mean)}  改错 ${num(r.guide_mean)}  胜/负/平 ${r.wins}/${r.losses}/${r.ties}`
    );
  }
  if (problems.length) console.log('[blind] 提示：\n  ' + problems.join('\n  '));
  console.log(`[blind] 结果：${path.relative(REPO_ROOT, mdPath)}`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || (args.key ? 'score' : 'export');
if (cmd === 'export') doExport(args);
else if (cmd === 'score') doScore(args);
else {
  console.error(`未知子命令 "${cmd}"，可用：export / score`);
  process.exit(2);
}
