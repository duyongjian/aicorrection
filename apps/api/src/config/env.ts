/**
 * 环境变量解析 + Provider 配置契约（§7.5）
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 优先加载 apps/api/.env（npm -w 运行时 cwd 即 apps/api），回退根 .env
const apiEnv = path.resolve(__dirname, '../../.env');
const rootEnv = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(apiEnv)) {
  dotenv.config({ path: apiEnv });
} else if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
} else {
  dotenv.config();
}

function toBool(value: string | undefined, def: boolean): boolean {
  if (value === undefined || value === '') return def;
  return value === 'true' || value === '1';
}

function toNum(value: string | undefined, def: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}

export type LlmProviderKind = 'ollama' | 'mock' | 'openai';

export const env = {
  PORT: toNum(process.env.PORT, 3001),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  API_BASE_PATH: process.env.API_BASE_PATH ?? '/api/v1',

  LLM_PROVIDER: (process.env.LLM_PROVIDER ?? 'ollama') as LlmProviderKind,
  LLM_BASE_URL: process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1',
  LLM_API_KEY: process.env.LLM_API_KEY ?? 'ollama',
  LLM_MODEL: process.env.LLM_MODEL ?? 'qwen2.5:0.5b',
  VISION_MODEL: process.env.VISION_MODEL ?? 'llama3.2-vision',
  AUTO_FALLBACK_TO_MOCK: toBool(process.env.AUTO_FALLBACK_TO_MOCK, true),

  // 调用超时（可配置；本机小参数模型首加载较慢，默认放宽到 45s）
  ATTRIBUTION_TIMEOUT_MS: toNum(process.env.ATTRIBUTION_TIMEOUT_MS, 45_000),
  FOLLOWUP_TIMEOUT_MS: toNum(process.env.FOLLOWUP_TIMEOUT_MS, 30_000),
  OCR_TIMEOUT_MS: toNum(process.env.OCR_TIMEOUT_MS, 30_000),

  DATA_DIR: path.resolve(__dirname, '../data'),
  DB_PATH:
    process.env.DB_PATH ??
    path.resolve(__dirname, '../data/aicorrection.db'),
  UPLOAD_DIR:
    process.env.UPLOAD_DIR ??
    path.resolve(__dirname, '../data/uploads'),
};
