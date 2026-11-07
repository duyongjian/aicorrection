/**
 * 线下分发环境 —— 单一权威配置源。
 *
 * 分发版与生产版共用同一份代码，但**必须使用独立 SQLite 库与 uploads 目录**：
 * 未显式设置 AICORRECTION_DB_PATH 时，apps/api/src/db 会沿用 env.DB_PATH
 * （tsx 直跑 src 时即 apps/api/src/data/aicorrection.db，约 335MB 的生产库）。
 * 本模块把所有「指向分发环境」的环境变量集中到一处，发卡 CLI 与一键启动脚本
 * 都只依赖它，避免两边各写一份而漂移。
 *
 * 注意：apps/api/src/config/env.ts 在模块加载时会执行 dotenv.config()，
 * dotenv 默认不覆盖已存在的 process.env 键。因此必须在 import 任何 API 代码
 * **之前**把这里的覆盖项写入 process.env / 子进程 env，才能压过 apps/api/.env。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录（git 根），所有分发路径都以它为基准。 */
export const REPO_ROOT = path.resolve(__dirname, '..');

/** 分发产物目录：独立库、uploads、以及建议存放的明文 CSV。 */
export const DIST_DIR = path.join(REPO_ROOT, 'data', 'distribution');
export const DEFAULT_DIST_DB = path.join(DIST_DIR, 'aicorrection-dist.db');
export const DIST_UPLOADS_DIR = path.join(DIST_DIR, 'uploads');

/**
 * 防呆：生产库绝不能作为分发库被写入。
 *
 * 任务给定的生产库名是 apps/api/data/aicorrection.db；
 * 而 tsx 直接跑 src 时 env.DB_PATH 实际解析为
 * apps/api/src/data/aicorrection.db（约 335MB），两者一并拦下；
 * 再对「任何落在 apps/api 下且名为 aicorrection.db 的文件」做兜底拦截。
 */
export function assertNotProductionDb(dbPath) {
  const resolved = path.resolve(dbPath);
  const norm = resolved.replace(/\\/g, '/');
  const basename = path.basename(resolved);
  const hitsNamedProd =
    norm.endsWith('/apps/api/data/aicorrection.db') ||
    norm.endsWith('/apps/api/src/data/aicorrection.db');
  const looksLikeProd =
    basename === 'aicorrection.db' && norm.includes('/apps/api/');
  if (hitsNamedProd || looksLikeProd) {
    throw new Error(
      `拒绝操作：分发库落点疑似生产库 -> ${resolved}\n` +
        '请显式设置 AICORRECTION_DB_PATH（或 AICORRECTION_DIST_DB）指向 ' +
        'data/distribution/ 下的独立库，切勿指向 apps/api/** 下的 aicorrection.db。'
    );
  }
  return resolved;
}

/**
 * 解析生效的分发库绝对路径。
 * 优先级：AICORRECTION_DB_PATH > AICORRECTION_DIST_DB > 默认分发库。
 */
export function resolveDistDbPath(env = process.env) {
  const fromDbPath = (env.AICORRECTION_DB_PATH || '').trim();
  const fromDistDb = (env.AICORRECTION_DIST_DB || '').trim();
  return assertNotProductionDb(
    path.resolve(fromDbPath || fromDistDb || DEFAULT_DIST_DB)
  );
}

/**
 * 相对当前进程需要覆盖的环境变量。
 * 供 CLI 在 import service 前 Object.assign 到 process.env；
 * 也作为 buildChildEnv 的覆盖项来源。
 */
export function distEnvOverrides(base = process.env) {
  const port = (base.PORT || '').trim() || '3001';
  return {
    AICORRECTION_DB_PATH: resolveDistDbPath(base),
    UPLOAD_DIR: DIST_UPLOADS_DIR,
    LICENSE_GATE_ENABLED: 'true',
    NODE_ENV: 'production',
    PORT: port,
  };
}

/**
 * 构造传给 spawn 的完整子进程 env。
 * 必须 merge 原 env —— 只传覆盖项会丢掉 PATH 等系统变量，导致 npm 找不到。
 */
export function buildChildEnv(base = process.env, extra = {}) {
  return { ...base, ...distEnvOverrides(base), ...extra };
}

/** 确保分发目录（含 uploads）存在；返回生效库路径与目录。 */
export function ensureDistDirs(base = process.env) {
  const dbPath = resolveDistDbPath(base);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(DIST_UPLOADS_DIR, { recursive: true });
  return { dbPath, uploadsDir: DIST_UPLOADS_DIR, distDir: DIST_DIR };
}
