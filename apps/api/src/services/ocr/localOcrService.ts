/**
 * 本地 OCR 服务（Python 子进程，纯 CPU，非视觉大模型）
 *
 * 通过子进程调用 apps/api/scripts/ocr/ocr_cli.py：
 *   <OCR_PYTHON> <OCR_CLI> --engine rapid|paddle|tesseract --image "<路径>" [--formula]
 * CLI 保证 stdout 只有一行 JSON（内部已屏蔽 Paddle C++ 的 fd 1 输出）。
 *
 * 契约：失败一律 reject（是否降级由上层 ocrService 决定）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { env } from '../../config/env';
import { TIMEOUT } from '../../config/timeout';

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

/**
 * 对落盘后的图片执行本地 OCR。
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
