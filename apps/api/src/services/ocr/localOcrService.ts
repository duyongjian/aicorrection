/**
 * 本地 OCR 服务（Python 子进程，纯 CPU，非视觉大模型）
 *
 * 两种工作模式（由 env.OCR_PERSISTENT 控制，默认 true）：
 *
 *  1) 常驻 serve 模式（默认）：启动一个 Python 子进程（--serve），模型（RapidOCR /
 *     PP-FormulaNet-S 公式 / Paddle 文本）只加载一次，之后每个请求通过 stdin/stdout
 *     行 JSON 协议复用该进程。消除每次调用都重启 Python + 重载 Paddle/Rapid 的 ~16-18s 地板。
 *  2) 单次 one-shot 模式（OCR_PERSISTENT=false）：每次 spawn 一个一次性 Python 子进程，
 *     行为与改造前完全一致（兜底 / 回退路径）。
 *
 * 契约：失败一律 reject（是否降级由上层 ocrService 决定）。serve 模式任意异常都会透明
 * 回退到 one-shot，绝不向调用方抛 500。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../../config/env';
import { TIMEOUT } from '../../config/timeout';

// serve 子进程 stderr 落盘（此前被整段吞掉，导致崩溃无迹可寻）。
// 固定路径便于复现/排障；仅追加写入，单文件。
const SERVE_STDERR_LOG = path.join(os.tmpdir(), 'aicorrection-ocr-serve-stderr.log');
function ensureStderrLog() {
  try {
    if (!fs.existsSync(SERVE_STDERR_LOG)) fs.writeFileSync(SERVE_STDERR_LOG, '');
  } catch {
    /* 忽略：日志不可用不应影响主流程 */
  }
  return SERVE_STDERR_LOG;
}

export type LocalOcrEngine = 'rapid' | 'paddle' | 'tesseract';

export interface LocalOcrTextItem {
  text: string;
  /** Tesseract 无置信度，为 null */
  score: number | null;
  /** 四边形坐标，Tesseract / 公式为 null */
  box: unknown | null;
}

export interface LocalOcrResult {
  texts: LocalOcrTextItem[];
  /** CLI 报告的墙钟耗时（秒） */
  elapsed_wall: number;
  engine: LocalOcrEngine;
}

export interface LocalOcrOptions {
  engine: LocalOcrEngine;
  /** 仅 paddle 引擎支持（PP-FormulaNet-S）；其余引擎 CLI 会返回 ok:false */
  formula?: boolean;
}

interface CliPayload {
  ok: boolean;
  engine: string;
  formula: boolean;
  elapsed_wall: number;
  elapsed_engine: number;
  count: number;
  texts: LocalOcrTextItem[];
  error?: string;
}

// 常驻 serve 模式开关（默认开）。false 退回每次 spawn 单次模式。
// env.OCR_PERSISTENT 已由 toBool 归一为 boolean（默认 true）。
const OCR_PERSISTENT = env.OCR_PERSISTENT === true;

// ---------------- 常驻 serve 子进程（模型只加载一次）----------------
interface ServePending {
  resolve: (r: LocalOcrResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let serveProcess: ChildProcessWithoutNullStreams | null = null;
let serveReady: Promise<ChildProcessWithoutNullStreams> | null = null;
const servePending = new Map<string, ServePending>();
let serveSeq = 0;

function killServeProcess(): void {
  if (serveProcess) {
    try {
      serveProcess.kill();
    } catch {
      /* ignore */
    }
  }
  serveProcess = null;
  serveReady = null;
}

/**
 * 懒启动并返回常驻 serve 子进程；首次调用支付模型加载开销（CLI 在输出 ready 前已
 * 一次性加载全部引擎）。后续调用直接复用已就绪的进程。
 */
function getServeProcess(): Promise<ChildProcessWithoutNullStreams> {
  if (serveProcess) return Promise.resolve(serveProcess);
  if (serveReady) return serveReady;

  const ready = new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
    const child = spawn(env.OCR_PYTHON, [env.OCR_CLI, '--serve'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    serveProcess = child;

    let buf = '';
    let settled = false;

    const onData = (d: Buffer): void => {
      buf += d.toString('utf8');
      const parts = buf.split(/\r?\n/);
      // 保留最后一段未完成的行
      buf = parts.pop() ?? '';
      for (const rawLine of parts) {
        const line = rawLine.trim();
        if (!line.startsWith('{')) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // 丢弃无法解析的行（如 Paddle 偶发噪声）
        }
        if (obj && obj.ready === true) {
          if (!settled) {
            settled = true;
            resolve(child);
          }
          continue;
        }
        if (obj && obj.req && obj.req.id !== undefined) {
          const id = String(obj.req.id);
          const pend = servePending.get(id);
          if (pend) {
            servePending.delete(id);
            clearTimeout(pend.timer);
            const payload = obj.payload as CliPayload | undefined;
            if (!payload || payload.ok === false) {
              pend.reject(
                new Error(
                  `本地 OCR 返回失败（engine=${obj.req.engine ?? '?'}）：${
                    payload?.error ?? '未知错误'
                  }`
                )
              );
            } else {
              pend.resolve({
                texts: Array.isArray(payload.texts) ? payload.texts : [],
                elapsed_wall: Number(payload.elapsed_wall) || 0,
                engine: obj.req.engine ?? 'unknown',
              });
            }
          }
        }
      }
    };

    child.stdout.on('data', onData);
    // serve 崩溃/噪声落盘（此前整段被吞，导致崩溃无法诊断）。
    // 每个事件前缀 pid，便于把 stderr 与具体 serve 实例关联。
    const stderrLog = ensureStderrLog();
    const pidTag = `[serve pid=${child.pid}] `;
    child.stderr.on('data', (d: Buffer) => {
      try {
        const text = d.toString('utf8');
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) fs.appendFileSync(stderrLog, pidTag + line + '\n');
        }
      } catch {
        /* 忽略日志写入失败 */
      }
    });
    child.on('error', (e: Error) => {
      if (!settled) {
        settled = true;
        killServeProcess();
        reject(e);
      }
    });
    child.on('close', (code: number | null) => {
      // 进程退出：清掉所有挂起请求，避免调用方永久挂起
      for (const [, pend] of servePending) {
        clearTimeout(pend.timer);
        pend.reject(new Error(`serve 进程退出（exit=${code}）`));
      }
      servePending.clear();
      if (!settled) {
        settled = true;
        serveProcess = null;
        serveReady = null;
        reject(new Error(`serve 进程提前退出（exit=${code}）`));
      } else {
        serveProcess = null;
        serveReady = null;
      }
    });
    // 启动硬超时：若未在 OCR_LOCAL_TIMEOUT_MS 内 ready，放弃 serve，上层回退 one-shot
    setTimeout(() => {
      if (!settled) {
        settled = true;
        killServeProcess();
        reject(new Error('serve 启动超时'));
      }
    }, TIMEOUT.OCR_LOCAL_MS);
  });

  serveReady = ready;
  return ready;
}

/**
 * 经常驻进程执行本地 OCR。请求写入 stdin，按回显的 req.id 匹配 stdout 响应。
 * 超时 / 进程异常时 reject，由上层 runLocalOcr 透明回退 one-shot。
 */
function runLocalOcrServe(
  imagePath: string,
  opts: LocalOcrOptions
): Promise<LocalOcrResult> {
  return getServeProcess().then((child) => {
    const id = String(++serveSeq);
    return new Promise<LocalOcrResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        servePending.delete(id);
        // 该请求超时：杀掉并重启 serve，避免卡死的进程拖垮后续请求
        killServeProcess();
        reject(
          new Error(
            `本地 OCR（serve）超时（${TIMEOUT.OCR_LOCAL_MS}ms，engine=${opts.engine}）`
          )
        );
      }, TIMEOUT.OCR_LOCAL_MS);
      servePending.set(id, { resolve, reject, timer });
      const req = {
        id,
        engine: opts.engine,
        image: imagePath,
        formula: !!opts.formula,
      };
      child.stdin.write(JSON.stringify(req) + '\n');
    });
  });
}

/**
 * 预热本地 OCR 常驻进程（模型只加载一次）。
 * 应在服务启动早期调用一次，使首个用户请求不再承担模型加载开销。
 * best-effort：失败不抛错，后续请求走 one-shot 或懒加载。
 */
export function warmupLocalOcr(): Promise<void> {
  if (!OCR_PERSISTENT) return Promise.resolve();
  return getServeProcess()
    .then(() => undefined)
    .catch(() => undefined);
}

// 进程退出时回收常驻子进程
process.on('exit', () => {
  killServeProcess();
});

// ---------------- 单次 one-shot（兜底 / 回退）----------------
/**
 * 单次模式：每次 spawn 一个一次性 Python 子进程，行为与改造前一致。
 * CLI 保证 stdout 只有一行 JSON（内部已屏蔽 Paddle C++ 的 fd 1 输出）。
 */
function runLocalOcrOneShot(
  imagePath: string,
  opts: LocalOcrOptions
): Promise<LocalOcrResult> {
  const args = [
    env.OCR_CLI,
    '--engine',
    opts.engine,
    '--image',
    imagePath,
  ];
  if (opts.formula) args.push('--formula');

  return new Promise<LocalOcrResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(env.OCR_PYTHON, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (err: Error | null, value?: LocalOcrResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value as LocalOcrResult);
    };

    // 硬超时：kill 子进程，防止 Paddle 冷启/卡死拖垮请求
    const timer = setTimeout(() => {
      child.kill();
      finish(
        new Error(
          `本地 OCR 超时（${TIMEOUT.OCR_LOCAL_MS}ms，engine=${opts.engine}）`
        )
      );
    }, TIMEOUT.OCR_LOCAL_MS);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (e: Error) => {
      finish(
        new Error(
          `本地 OCR 进程启动失败（python=${env.OCR_PYTHON}）：${e.message}`
        )
      );
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      // 日志行/告警可能混入，取最后一条以 '{' 开头的行作为 JSON
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('{'));
      const jsonLine = lines.length > 0 ? lines[lines.length - 1] : '';

      let payload: CliPayload | null = null;
      if (jsonLine) {
        try {
          payload = JSON.parse(jsonLine) as CliPayload;
        } catch {
          payload = null;
        }
      }

      if (!payload) {
        finish(
          new Error(
            `本地 OCR 输出解析失败（exit=${code}）：stdout=${
              stdout.slice(0, 300) || '<空>'
            } stderr=${stderr.slice(0, 300)}`
          )
        );
        return;
      }
      if (!payload.ok) {
        finish(
          new Error(
            `本地 OCR 返回失败（engine=${opts.engine}）：${payload.error ?? '未知错误'}`
          )
        );
        return;
      }
      if (code !== 0) {
        finish(
          new Error(`本地 OCR 退出码非 0（exit=${code}，engine=${opts.engine}）`)
        );
        return;
      }

      finish(null, {
        texts: Array.isArray(payload.texts) ? payload.texts : [],
        elapsed_wall: Number(payload.elapsed_wall) || 0,
        engine: opts.engine,
      });
    });
  });
}

// ---------------- 对外入口 ----------------
/**
 * 对落盘后的图片执行本地 OCR。
 * 默认走常驻 serve 进程（模型只加载一次）；serve 任意失败透明回退 one-shot。
 * @throws 图片不存在 / 进程启动失败 / 超时 / CLI 返回 ok:false / 退出码非 0
 */
export function runLocalOcr(
  imagePath: string,
  opts: LocalOcrOptions
): Promise<LocalOcrResult> {
  // 入参存在性检查：避免 spawn 一个注定白跑的进程
  if (!fs.existsSync(imagePath)) {
    return Promise.reject(new Error(`本地 OCR 失败：图片不存在 ${imagePath}`));
  }

  if (OCR_PERSISTENT) {
    // serve 失败：先重启 serve 重试一次（超时/退出已 killServeProcess，下次
    // getServeProcess 会重新 spawn 并复用模型热态，避免直接跌回 16-18s 的 one-shot 地板）；
    // 仍失败才透明回退 one-shot（绝不抛 500，降级由上层 ocrService 决定）。
    return runLocalOcrServe(imagePath, opts)
      .catch(() => runLocalOcrServe(imagePath, opts))
      .catch((serveErr) => runLocalOcrOneShot(imagePath, opts));
  }
  return runLocalOcrOneShot(imagePath, opts);
}
