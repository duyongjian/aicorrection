/**
 * 识别端（视觉大模型）按需拉起 / 空闲自动退出
 *
 * 背景：本机 RTX 4060 Laptop 显存仅 8188 MiB，而分析强模型 Qwen3.8-27B
 * 权重就有 8.17 GiB。若识别端（MiniCPM-V-4.5，约 5.77 GiB）与分析端常驻共存，
 * 分析模型只能分到约 2.4 GiB，大量层溢出 CPU，decode 仅约 2.5~3 tok/s。
 * 实测：腾出显存后同样难题的归因从 161s 降到 89.2s。
 *
 * 因此识别端改为「按需拉起、用完即停」，且默认以 CPU/低 -ngl 运行，
 * 避免与常驻的分析模型争抢显存。
 *
 * 设计要点：
 *  - 默认关闭（RECOGNITION_AUTOSTART=false），不配启动命令则行为完全不变
 *  - 幂等：已在线直接返回 true；并发调用合并为同一个启动 Promise
 *  - 诚实：拉起失败或超时 → 返回 false，交由上层如实降级（不得造假数据）
 *  - 空闲自动退出：最后一次调用后 N 毫秒无人使用则 kill 进程，释放显存
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { env } from '../../config/env';

/** 探活：识别端（视觉大模型，独立 VISION_BASE_URL）是否已在提供服务（只探测，不拉起）。 */
export async function probeRecognition(timeoutMs = 3000): Promise<boolean> {
  const url = env.VISION_BASE_URL.replace(/\/+$/, '') + '/models';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let inFlight: Promise<boolean> | null = null;
let child: ChildProcess | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function clearIdle(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleShutdown(): void {
  clearIdle();
  if (env.RECOGNITION_IDLE_SHUTDOWN_MS <= 0) return;
  idleTimer = setTimeout(() => {
    stopRecognition();
  }, env.RECOGNITION_IDLE_SHUTDOWN_MS);
  // 定时器不应阻止进程退出
  (idleTimer as unknown as { unref?: () => void }).unref?.();
}

/** 按需拉起识别端；返回是否已就绪。 */
export async function ensureRecognitionReady(): Promise<boolean> {
  if (await probeRecognition()) {
    scheduleIdleShutdown();
    return true;
  }
  if (!env.RECOGNITION_AUTOSTART) return false;

  const cmd = env.RECOGNITION_START_CMD;
  if (!cmd) return false;

  // 并发合并：同一时刻只拉起一次
  if (!inFlight) {
    inFlight = (async () => {
      try {
        child = spawn(cmd, {
          shell: true,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();

        const deadline = Date.now() + env.RECOGNITION_STARTUP_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (await probeRecognition(1500)) return true;
          await new Promise((r) => setTimeout(r, 2000));
        }
        return false;
      } catch {
        return false;
      }
    })();
  }

  try {
    return await inFlight;
  } finally {
    inFlight = null;
    if (child) scheduleIdleShutdown();
  }
}

/** 停止由本模块拉起的识别端进程（仅清理自己拉起的，不误杀外部实例）。 */
export function stopRecognition(): void {
  clearIdle();
  const c = child;
  child = null;
  if (!c || c.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      c.kill('SIGTERM');
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}
