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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, 'apps', 'api', '.env');
const CHECK_ONLY = process.argv.includes('--check');

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
  openBrowser('http://localhost:5173');
}, 8000);

console.log(`[3/3] 访问 http://localhost:5173 （API 健康检查 http://localhost:${API_PORT}/health）`);
console.log('');

const devCode = await run('npm', ['run', 'dev'], { stdio: 'inherit' });
clearTimeout(t);
process.exit(devCode ?? 0);

// ── helpers ─────────────────────────────────────────────────────────────────
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      shell: process.platform === 'win32',
      ...opts,
    });
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
