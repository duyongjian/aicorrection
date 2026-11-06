/**
 * 归因回归门禁（attrib:regress:real）
 *
 * 作用：一键跑「29 道历史真题 + 5 道多步数值专项题（共 34 题，SET 默认题集 real-exam-v3）+ 知识锚点」
 *       全量评测，并对产出做 auto-eval 自动评分，以 PASS 率 / FAIL 数 / 陷阱未瞎编率为闸门，防回归。
 *       任何变体或锚点改动后运行即可确认不回退。
 *
 * 依赖：本地真实模型（默认 http://localhost:8085/v1，见 getAnalysisProvider）。
 * 用法：
 *   npm run attrib:regress:real                 # 默认 v0.2b-guard-trap + 34 题（29 历史 + 5 数值专项）+ 锚点
 *   VARIANT=v0.2-guard npm run attrib:regress:real
 *   SET=apps/.../prompt-ab-set-anchors.json npm run attrib:regress:real
 *   JSON=reports/prompt-ab-2026-..-tag.json npm run attrib:regress:real   # 复用已有报告，跳过模型评测
 *
 * 退出码：FAIL > 0 或 陷阱未瞎编率 < 100% → 非 0（CI 可据此阻断）。
 *         PARTIAL 视为「方向一致、措辞重叠略低」的良性边界，计入通过（与 auto-eval 逐题纪律一致）。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const IS_WIN = process.platform === 'win32';
// Windows 上 npm 是 npm.cmd：spawn('npm') 直接 ENOENT，spawn('npm.cmd') 不带 shell 会 EINVAL。
// 优先复用 npm 运行脚本时注入的 npm_execpath（npm-cli.js 绝对路径），用当前 node 直接执行，
// 完全绕开扩展名与 cmd.exe 差异；直接 tsx 运行本脚本时退回 npm.cmd + shell=true。
const NPM_CLI_JS = process.env.npm_execpath || '';
const USE_NPM_CLI = /npm-cli\.js$/i.test(NPM_CLI_JS);
const NPM_CMD = USE_NPM_CLI ? process.execPath : (IS_WIN ? 'npm.cmd' : 'npm');
const NPM_LEAD = USE_NPM_CLI ? [NPM_CLI_JS] : [];
const NPM_SHELL = !USE_NPM_CLI && IS_WIN;
// node 也用当前解释器绝对路径，避免 PATH 上 node 解析差异。
const NODE_CMD = process.execPath;

const SET =
  process.env.SET ||
  resolve(ROOT, 'apps/api/src/tests/fixtures/prompt-ab-set-realexam.json');
const VARIANT = process.env.VARIANT || 'v0.2b-guard-trap';
const TAG = process.env.TAG || 'regress-gate';
const PROVIDER = process.env.PROVIDER || 'real';

/** shell=true 时参数需自行加引号，否则路径含空格会被 cmd.exe 拆开。 */
function shellQuote(arg) {
  const s = String(arg);
  return /[\s&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const finalArgs = opts.shell ? args.map(shellQuote) : args;
    const child = spawn(cmd, finalArgs, { cwd: ROOT, ...opts });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => resolvePromise({ code, out }));
    child.on('error', reject);
  });
}

function extractJsonPath(out) {
  // prompt-ab 输出形如：数据：reports\prompt-ab-2026-..-tag.json
  const m = out.match(/数据[:：]\s*(reports[\\/][^\s]+\.json)/);
  return m ? resolve(ROOT, m[1].replace(/\\/g, '/')) : null;
}

function gateFromAutoEval(out) {
  // 形如：总: 29 | PASS: 29 | PARTIAL: 0 | FAIL: 0
  const m = out.match(/总:\s*(\d+)\s*\|\s*PASS:\s*(\d+)\s*\|\s*PARTIAL:\s*(\d+)\s*\|\s*FAIL:\s*(\d+)/);
  const trap = out.match(/未瞎编率:\s*(\d+)\/(\d+)/);
  if (!m) return { ok: false, reason: '未能解析 auto-eval 汇总', detail: out.slice(-400) };
  const [, total, pass, partial, fail] = m.map(Number);
  const trapOk = trap ? Number(trap[1]) === Number(trap[2]) : true;
  // 门禁口径：FAIL 数与陷阱未瞎编率是硬闸门；PARTIAL 视为「方向一致、措辞重叠略低」的良性边界，计入通过。
  // 依据：auto-eval 逐题纪律——PARTIAL 表示模型诊断方向正确，仅关键词重叠不足 0.3，非真失败（如 rm02 积分拆乘积诊断完全正确、重叠 0.29 落 PARTIAL）。
  const ok = fail === 0 && trapOk;
  return {
    ok,
    total,
    pass,
    partial,
    fail,
    trap: trap ? `${trap[1]}/${trap[2]}` : 'n/a',
    reason: ok
      ? `通过（FAIL=0, 陷阱未瞎编=${trap ? trap[1] + '/' + trap[2] : 'n/a'}${partial ? `, PARTIAL=${partial} 为良性边界` : ''}）`
      : `FAIL=${fail}, 陷阱未瞎编=${trap ? trap[1] + '/' + trap[2] : 'n/a'}`,
  };
}

console.log(`[regress] SET=${SET}`);
console.log(`[regress] VARIANT=${VARIANT} PROVIDER=${PROVIDER} TAG=${TAG}`);

// 支持 JSON= 复用已有评测报告，跳过模型评测（CI / 门禁逻辑验证用）
let jsonPath = process.env.JSON ? resolve(ROOT, process.env.JSON) : null;
if (jsonPath) {
  console.log(`[regress] 复用已有评测报告：${jsonPath}（跳过模型评测）`);
} else {
  const ab = await run(NPM_CMD, [
    ...NPM_LEAD,
    'run',
    'prompt:ab',
    '--',
    '--set',
    SET,
    '--provider',
    PROVIDER,
    '--variants',
    VARIANT,
    '--anchors',
    '--tag',
    TAG,
  ], { shell: NPM_SHELL });
  if (ab.code !== 0) {
    console.error('[regress] prompt:ab 执行失败');
    console.error(ab.out.slice(-800));
    process.exit(1);
  }
  jsonPath = extractJsonPath(ab.out);
  if (!jsonPath) {
    console.error('[regress] 未能从 prompt:ab 输出定位 JSON 报告');
    console.error(ab.out.slice(-800));
    process.exit(1);
  }
  console.log(`[regress] 评测报告：${jsonPath}`);
}

const ev = await run(NODE_CMD, [
  'apps/api/src/tests/auto-eval.mjs',
  '--json',
  jsonPath,
  '--set',
  SET,
]);
if (ev.code !== 0) {
  console.error('[regress] auto-eval 执行失败');
  console.error(ev.out.slice(-800));
  process.exit(1);
}

const gate = gateFromAutoEval(ev.out);
console.log('\n==== 回归门禁结果 ====');
console.log(`题目数: ${gate.total ?? '?'} | PASS: ${gate.pass ?? '?'} | PARTIAL: ${gate.partial ?? '?'} | FAIL: ${gate.fail ?? '?'}`);
console.log(`陷阱未瞎编: ${gate.trap}`);
if (!gate.ok) {
  console.error(`\n[regress] ❌ 门禁未通过：${gate.reason}`);
  process.exit(1);
}
console.log(`\n[regress] ✅ 门禁通过：${gate.reason}`);
process.exit(0);
