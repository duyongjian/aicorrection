/**
 * 错题强化闭环 · 一键启动【真实大模型模式】(Node 版，跨 shell 可靠)
 *
 * 为什么不用 bash：
 *   Windows PowerShell 里 `bash` 可能解析到 C:\Windows\System32\bash.exe（WSL），
 *   WSL2 有独立网络命名空间，其 localhost ≠ Windows 主机 localhost，
 *   导致预检 8085/8090 全部 HTTP 000（连接被拒）。Node 直接跑在 Windows 上，
 *   不经 WSL，且用 http 模块直连（不走任何代理），彻底规避该问题。
 *
 * 设计原则：
 *   1. 不启动任何大模型服务 —— llama.cpp / Ollama 需自行在外部启动。
 *   2. 绝不 mock —— 强制 AUTO_FALLBACK_TO_MOCK=false，不覆盖 LLM_PROVIDER。
 *   3. 预检真实服务端点；未就绪只告警，不降级、不 mock。
 *
 * 用法：
 *   node scripts/start-test.mjs           # 预检 + 构建 shared + 启动 API/Web + 开浏览器
 *   node scripts/start-test.mjs --check   # 只做预检，不启动
 */
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELF_FILE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, 'apps', 'api', '.env');
const CHECK_ONLY = process.argv.includes('--check');
const NO_REEXEC = process.argv.includes('--no-reexec');
const NO_BROWSER = process.argv.includes('--no-browser');
const NATIVE_PKG = 'better-sqlite3';

// ═══ 0. 原生模块 ABI 自检 ═══════════════════════════════════════════════════
// 背景：本机可能同时装了多个 Node（如 WorkBuddy 自带 v22 → ABI 127，fnm 的
// v25 → ABI 141）。node_modules 里的 better_sqlite3.node 只对某一个 ABI 有效，
// 若用另一个 Node 启动 API，会抛：
//   ERR_DLOPEN_FAILED / NODE_MODULE_VERSION 127 vs 141
// 且表现为 Vite 代理疯狂 ECONNREFUSED（后端根本没起来），非常难定位。
// 因此这里在一切之前先验证，能就地纠正就静默纠正，纠正不了就给人话诊断。
const runtime = await ensureNativeRuntime();
if (runtime.reexeced) process.exit(runtime.exitCode);

// ── 读取 .env 中的非敏感配置（URL / 模型名 / 端口），不碰任何密钥 ──────────────
function readEnv(key, fallback = '') {
  let raw;
  try {
    raw = fs.readFileSync(ENV_FILE, 'utf8');
  } catch {
    return fallback;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (!t.startsWith(`${key}=`)) continue;
    let v = t.slice(key.length + 1);
    const hash = v.indexOf('#');
    if (hash >= 0) v = v.slice(0, hash);
    v = v.trim();
    return v || fallback;
  }
  return fallback;
}

const ANALYSIS_URL = readEnv('ANALYSIS_BASE_URL', 'http://localhost:8085/v1');
const RECOG_URL = readEnv('LLM_BASE_URL', 'http://localhost:8090/v1');
const ANALYSIS_MODEL = readEnv('ANALYSIS_MODEL', '');
const LLM_MODEL = readEnv('LLM_MODEL', '');
const LLM_PROVIDER = readEnv('LLM_PROVIDER', '');
const API_PORT = readEnv('PORT', '3001');
const OCR_PY =
  readEnv('OCR_PYTHON') ||
  'D:/AllSideProject/AICorrection/.venv-ocr/Scripts/python.exe';

// ── 预检：直连本机端口（http 模块不走任何代理环境变量）──────────────────────
// localhost 在 Windows 上会优先解析成 ::1 (IPv6)，而 llama.cpp 默认只监听 IPv4，
// 因此对 localhost 额外尝试 127.0.0.1 / ::1 两个候选。
function probeOnce(hostname, port, urlPath) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname,
        port,
        path: urlPath,
        method: 'GET',
        timeout: 3000,
        agent: false, // 关键：新建直连 socket，绝不复用任何代理连接池
      },
      (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

async function probe(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl.replace(/\/+$/, '') + '/models');
  } catch {
    return { code: 0, tried: [baseUrl] };
  }
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  const urlPath = u.pathname + u.search;

  const candidates =
    u.hostname === 'localhost'
      ? ['127.0.0.1', '::1'] // IPv4 优先，再试 IPv6
      : [u.hostname];

  let last = 0;
  for (const host of candidates) {
    last = await probeOnce(host, port, urlPath);
    if (last !== 0) break;
  }
  return { code: last, tried: candidates };
}

// ── 输出 ────────────────────────────────────────────────────────────────────
console.log('============================================================');
console.log('  错题强化闭环 · 一键启动【真实大模型模式 · 非 mock】');
console.log('============================================================');
console.log('');
console.log('  策略来源：apps/api/.env（脚本不覆盖模型地址，只做预检）');
console.log(
  `  provider = ${LLM_PROVIDER || '<默认>'}   识别模型 = ${LLM_MODEL || '<默认>'}  @ ${RECOG_URL}`
);
console.log(`  归因模型 = ${ANALYSIS_MODEL || '<默认>'}  @ ${ANALYSIS_URL}`);
console.log('  fallback = 强制关闭（AUTO_FALLBACK_TO_MOCK=false，绝不降级 mock）');
console.log('');

console.log('[预检] 真实大模型服务（本脚本不负责启动它们）:');
let missing = 0;

const r1 = await probe(ANALYSIS_URL);
if (r1.code === 200) {
  console.log(`  [就绪] 归因/分析端 (ANALYSIS_BASE_URL)`);
  console.log(`         ${ANALYSIS_URL}  (HTTP ${r1.code})`);
} else {
  console.log(`  [未就绪] 归因/分析端 (ANALYSIS_BASE_URL)`);
  console.log(`         ${ANALYSIS_URL}  (HTTP ${String(r1.code).padStart(3, '0')})`);
  missing += 1;
}

const r2 = await probe(RECOG_URL);
if (r2.code === 200) {
  console.log(`  [就绪] 识别/视觉端 (LLM_BASE_URL)`);
  console.log(`         ${RECOG_URL}  (HTTP ${r2.code})`);
} else {
  console.log(`  [未就绪] 识别/视觉端 (LLM_BASE_URL)`);
  console.log(`         ${RECOG_URL}  (HTTP ${String(r2.code).padStart(3, '0')})`);
  missing += 1;
}

if (OCR_PY && fs.existsSync(OCR_PY)) {
  console.log(`  [就绪] 本地 OCR 解释器  ${OCR_PY}`);
} else {
  console.log(`  [未就绪] 本地 OCR 解释器  ${OCR_PY || '<未配置>'}（不存在则上传走视觉大模型识别）`);
}
console.log('');

if (CHECK_ONLY) {
  console.log('--check 模式：仅预检，不启动服务。');
  process.exit(0);
}

if (missing > 0) {
  console.log(`  ⚠ 有 ${missing} 个真实服务未就绪。脚本【不会】降级为 mock，`);
  console.log('    仍会按 .env 策略直连真实服务；未就绪的端点在调用时才会报真实错误。');
  console.log('    请自行在外部启动对应大模型服务（例如 llama.cpp / Ollama），再重跑本脚本。');
  console.log('');
  const ans = await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('    仍要继续启动 API/Web 吗？[y/N] ', (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
  if (!/^y/i.test(ans)) {
    console.log('    已取消。');
    process.exit(1);
  }
  console.log('');
}

// ── 2. 构建共享包 ───────────────────────────────────────────────────────────
console.log('[1/3] 构建 @aicorrection/shared ...');
const buildCode = await run('npm', ['run', 'build:shared'], { stdio: 'inherit' });
if (buildCode !== 0) {
  console.log('shared 构建失败，已中止。');
  process.exit(1);
}
console.log('');

// ── 3. 启动（前台；Ctrl+C 同时结束 API 与 Web）───────────────────────────────
console.log(`[2/3] 启动 API(:${API_PORT}) + Web(:5173) ...`);
console.log('      停止请在本窗口按 Ctrl+C（不要用 taskkill 强杀 node）');
console.log('');

// 后台延时打开浏览器
const t = setTimeout(() => {
  if (!NO_BROWSER) openBrowser('http://localhost:5173');
}, 8000);

console.log(`[3/3] 访问 http://localhost:5173 （API 健康检查 http://localhost:${API_PORT}/health）`);
console.log('');

const devCode = await run('npm', ['run', 'dev'], { stdio: 'inherit' });
clearTimeout(t);
process.exit(devCode ?? 0);

// ── helpers ─────────────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    if (process.platform === 'win32') {
      // Windows 上 npm 是 .cmd，必须经 cmd.exe 转发。显式拼命令行而不是
      // spawn(shell:true)，可避免 Node 22+ 的 DEP0190 弃用告警（未转义拼接）。
      const line = [cmd, ...args].join(' ');
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
        cwd: ROOT,
        stdio: 'inherit',
        ...opts,
      });
    } else {
      child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
    }
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(1));
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打开浏览器失败不影响主流程 */
  }
}

// ── 原生模块 ABI 相关 ────────────────────────────────────────────────────────

/** 用指定 node 试跑一次真实建库；成功返回 {ok:true}，失败带回首行错误。 */
// 注意：只 require 不够 —— better-sqlite3 的 .node 绑定在 new Database() 时才真正
// dlopen，日志里的崩溃点正是 database.js:48 的构造函数。必须建库+查询才算验证通过。
function tryLoadNative(nodeExe) {
  const script = [
    'try {',
    `  const D = require(${JSON.stringify(NATIVE_PKG)});`,
    '  const db = new D(":memory:");',
    '  db.prepare("select 1 as x").get();',
    '  db.close();',
    '  process.exit(0);',
    '} catch (e) {',
    '  console.error((e && e.message) || String(e));',
    '  process.exit(9);',
    '}',
  ].join('\n');
  try {
    execFileSync(nodeExe, ['-e', script], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30000,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { ok: true, detail: '' };
  } catch (e) {
    const raw = String(e?.stderr || e?.message || '').trim();
    return { ok: false, detail: raw.split(/\r?\n/)[0] || 'unknown' };
  }
}

/** 读取指定 node 的版本与 ABI；不可执行返回 null。 */
function nodeInfo(nodeExe) {
  try {
    const out = execFileSync(
      nodeExe,
      ['-p', 'process.version + " ABI=" + process.versions.modules'],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    );
    return out.trim();
  } catch {
    return null;
  }
}

/** 收集本机可能存在的 node 可执行文件（PATH + 常见版本管理器目录）。 */
function discoverNodes() {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  const found = new Set();
  const push = (p) => {
    if (!p) return;
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) found.add(path.resolve(p));
    } catch {
      /* ignore */
    }
  };

  // ① PATH 中每一段
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) push(path.join(dir, exe));
  }

  // ② 版本管理器目录（WorkBuddy / fnm / nvm-windows / Volta / 官方安装包）
  const home = os.homedir();
  const roots = [
    path.join(home, '.workbuddy', 'binaries', 'node', 'versions'),
    process.env.FNM_DIR ? path.join(process.env.FNM_DIR, 'node-versions') : '',
    path.join(process.env.APPDATA || '', 'fnm', 'node-versions'),
    path.join(process.env.LOCALAPPDATA || '', 'fnm', 'node-versions'),
    path.join(process.env.APPDATA || '', 'nvm'),
    'C:\\nvm4w\\nodejs',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
    path.join(process.env.LOCALAPPDATA || '', 'Volta', 'tools', 'image', 'node'),
  ];

  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    let subs = [];
    try {
      subs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of subs) {
      if (!d.isDirectory()) continue;
      // .../v22.22.2-6/node.exe（WorkBuddy）
      push(path.join(root, d.name, exe));
      // .../v25.2.1/installation/node.exe（fnm）
      push(path.join(root, d.name, 'installation', exe));
      // .../v20.11.0/node.exe 之外，nvm 也可能是 .../v20.11.0/x64/node.exe
      push(path.join(root, d.name, 'x64', exe));
      push(path.join(root, d.name, 'bin', exe));
    }
  }

  return [...found];
}

/** 用兼容的 node 重新执行本脚本（并把它的目录前置到 PATH，让 npm/npx 同源）。 */
function reexecWith(nodeExe) {
  return new Promise((resolve) => {
    const dir = path.dirname(nodeExe);
    const env = {
      ...process.env,
      PATH: dir + path.delimiter + String(process.env.PATH || ''),
    };
    const child = spawn(nodeExe, [SELF_FILE, ...process.argv.slice(2), '--no-reexec'], {
      cwd: ROOT,
      stdio: 'inherit',
      env,
    });
    child.on('close', (code, signal) => resolve(signal ? 1 : code ?? 0));
    child.on('error', () => resolve(1));
  });
}

/**
 * 保证当前 Node 能加载 better-sqlite3。
 * 返回 { reexeced: true, exitCode } 表示已切换到兼容 Node 并执行完毕；
 * 否则返回 { ok: true }。
 */
async function ensureNativeRuntime() {
  const self = process.execPath;
  console.log('[运行环境] 原生模块 ABI 自检 ...');

  const first = tryLoadNative(self);
  if (first.ok) {
    console.log(
      `  [就绪] ${NATIVE_PKG} 可加载  (Node ${process.version}, ABI ${process.versions.modules})`
    );
    return { ok: true };
  }

  console.log(
    `  [警告] 当前 Node ${process.version}（ABI ${process.versions.modules}）无法加载 ${NATIVE_PKG}`
  );
  console.log(`         ${first.detail}`);

  // ① 先找本机其它能直接加载的 Node（零成本，优先；不破坏现有二进制）
  if (!NO_REEXEC) {
    const candidates = discoverNodes().filter(
      (p) => path.resolve(p) !== path.resolve(self)
    );
    const tried = [];
    for (const exe of candidates) {
      const info = nodeInfo(exe);
      if (!info) continue;
      if (tryLoadNative(exe).ok) {
        console.log(`  [修复] 找到兼容 Node：${exe}`);
        console.log(`         ${info} → 自动切换并重启本脚本`);
        console.log('');
        const code = await reexecWith(exe);
        return { reexeced: true, exitCode: code };
      }
      tried.push(`${info}  ${exe}`);
    }
    if (tried.length > 0) {
      console.log('  [信息] 已排查以下 Node，均无法加载当前二进制：');
      for (const t of tried) console.log(`         ${t}`);
    }
  }

  // ② 没有现成的 → 就地重建二进制（可能触发源码编译，耗时较长）
  console.log('  [修复] 尝试为当前 Node 重建原生模块（可能需要几分钟）...');
  const rebuildCode = await run('npm', ['rebuild', NATIVE_PKG, '--update-binary']);
  if (rebuildCode === 0 && tryLoadNative(self).ok) {
    console.log(`  [修复] 重建成功，${NATIVE_PKG} 已适配 ABI ${process.versions.modules}`);
    return { ok: true };
  }

  // ③ 全失败 → 给出人话诊断，而不是让 API 一启动就崩
  console.error('');
  console.error('  ✗ 无法让 better-sqlite3 与当前 Node 匹配。API 启动必然失败，已中止。');
  console.error('');
  console.error(`    当前 Node : ${process.version}  ABI=${process.versions.modules}  ${self}`);
  console.error(`    原生二进制 : ${path.join(ROOT, 'node_modules', NATIVE_PKG, 'build', 'Release', 'better_sqlite3.node')}`);
  console.error('');
  console.error('    请任选一种方式处理：');
  console.error('      A) 切到与二进制匹配的 Node 后重跑（推荐，最快）：');
  console.error('         fnm use 22      # 或 nvm use 22.22.2');
  console.error('         npm run start:test');
  console.error('      B) 为当前 Node 重新编译（需已安装 VS Build Tools）：');
  console.error('         npm rebuild better-sqlite3 --update-binary');
  console.error('      C) 重装依赖（会按当前 Node 重新下载预编译二进制）：');
  console.error('         rmdir /s /q node_modules && npm install');
  console.error('');
  process.exit(1);
}
