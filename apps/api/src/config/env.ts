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

// LLM_* 基线值：分析端 ANALYSIS_* 未显式配置时回落到这里，
// 保证"未配置 ANALYSIS_*"时分析 provider 与识别 provider 指向同一端点、同一模型，
// 行为与拆分前完全一致（向后兼容硬要求）。
const llmBaseUrl = process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1';
const llmApiKey = process.env.LLM_API_KEY ?? 'ollama';
const llmModel = process.env.LLM_MODEL ?? 'qwen2.5:0.5b';

export const env = {
  PORT: toNum(process.env.PORT, 3001),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  API_BASE_PATH: process.env.API_BASE_PATH ?? '/api/v1',

  LLM_PROVIDER: (process.env.LLM_PROVIDER ?? 'ollama') as LlmProviderKind,
  LLM_BASE_URL: llmBaseUrl,
  LLM_API_KEY: llmApiKey,
  LLM_MODEL: llmModel,
  VISION_MODEL: process.env.VISION_MODEL ?? 'llama3.2-vision',
  // 无 Mock 策略（产品硬约束）：真实模型失败必须如实返回失败，绝不用假数据凑数。
  // 默认 false —— 仅在显式打开时，真实模型不可达才降级 Mock（演示用）。
  AUTO_FALLBACK_TO_MOCK: toBool(process.env.AUTO_FALLBACK_TO_MOCK, false),

  // ---- 分析 / 归因 专用模型（与"识别/视觉"分家）----
  // 背景：本地 MiniCPM-V-4.5 做视觉识别够用，但做"归因分析"会臆造错因；
  // 故归因/追问可指向另一个更强的本地大模型（例如另起 llama.cpp 实例跑更大的 Qwen）。
  // 三者均默认回落上面的 LLM_*，未配置时行为与分家前完全一致。
  ANALYSIS_BASE_URL: process.env.ANALYSIS_BASE_URL ?? llmBaseUrl,
  ANALYSIS_MODEL: process.env.ANALYSIS_MODEL ?? llmModel,
  ANALYSIS_API_KEY: process.env.ANALYSIS_API_KEY ?? llmApiKey,

  /**
   * 是否关闭模型的思考链（thinking）。默认 true。
   * 依据：分析强模型 Qwen3.8-27B 跑在 RTX 4060 Laptop（显存仅 8188 MiB，
   * 而权重 8.2GB）→ 大量层溢出到 CPU，实测生成仅 2.5~3.1 tok/s。
   * 真实归因实测：thinking 开启 266s / 614 completion token；
   * thinking 关闭 161s / 448 token。故关闭 thinking 是唯一性价比可接受的解。
   * 严禁改用"收紧 prompt 禁止推导"来提速 —— 实测该变体虽只要 62s，
   * 但会丢失诊断能力（把有符号错误的作答误判为"解法正确"），已被否决。
   */
  DISABLE_THINKING: toBool(process.env.DISABLE_THINKING, true),

  // 调用超时（可配置）。默认按分析强模型 Qwen3.8-27B @ RTX4060 8GB 显存标定：
  // 显存不足导致层溢出 CPU，~3 tok/s；thinking 关闭后实测单次归因 161s，
  // 300s 留约 1.8x 余量；追问走同一强模型，180s 留约 1.1x（追问更短）。
  ATTRIBUTION_TIMEOUT_MS: toNum(process.env.ATTRIBUTION_TIMEOUT_MS, 300_000),
  FOLLOWUP_TIMEOUT_MS: toNum(process.env.FOLLOWUP_TIMEOUT_MS, 180_000),
  OCR_TIMEOUT_MS: toNum(process.env.OCR_TIMEOUT_MS, 30_000),

  // ---- 本地 OCR（Python 子进程，纯 CPU，非视觉大模型）----
  /** auto=优先本地、失败降级视觉大模型；local=只用本地；llm=只用视觉大模型 */
  OCR_MODE: (process.env.OCR_MODE ?? 'auto') as 'auto' | 'local' | 'llm',
  /** 文本识别引擎（实测 RapidOCR ~2.4s；Paddle 做文本 ~17s 太慢，勿用） */
  OCR_TEXT_ENGINE: (process.env.OCR_TEXT_ENGINE ?? 'rapid') as
    | 'rapid'
    | 'paddle'
    | 'tesseract',
  /** 命中数学信号时是否自动跑一次 Paddle 公式识别（PP-FormulaNet-S，~1.3s） */
  OCR_FORMULA_AUTO: toBool(process.env.OCR_FORMULA_AUTO, true),
  /** Python 解释器（指向装有 rapidocr/paddleocr/pytesseract 的 venv） */
  OCR_PYTHON:
    process.env.OCR_PYTHON ??
    'D:/AllSideProject/AICorrection/.venv-ocr/Scripts/python.exe',
  /** OCR CLI 脚本路径（默认解析到 apps/api/scripts/ocr/ocr_cli.py） */
  OCR_CLI:
    process.env.OCR_CLI ??
    path.resolve(__dirname, '../../scripts/ocr/ocr_cli.py'),
  /** 本地 OCR 子进程超时（Paddle 冷启可能 17s+，比 OCR_TIMEOUT_MS 更宽松） */
  OCR_LOCAL_TIMEOUT_MS: toNum(process.env.OCR_LOCAL_TIMEOUT_MS, 60_000),

  // ---- 识别端（视觉大模型）按需拉起 ----
  // 背景：显存 8188 MiB 装不下「分析 27B」+「识别 8B」同时常驻，
  // 同驻时分析模型大量层溢出 CPU（decode 仅 ~2.5~3 tok/s，同题归因 161s）；
  // 腾出显存后降至 89.2s。故识别端改为按需拉起、空闲自动退出。
  // 默认 false：不配 RECOGNITION_START_CMD 时，行为与改造前完全一致。
  RECOGNITION_AUTOSTART: toBool(process.env.RECOGNITION_AUTOSTART, false),
  /** 拉起识别端实例的完整命令行（detached 执行） */
  RECOGNITION_START_CMD: process.env.RECOGNITION_START_CMD ?? '',
  /** 拉起后等待就绪的超时（模型加载约 40s，故放宽） */
  RECOGNITION_STARTUP_TIMEOUT_MS: toNum(
    process.env.RECOGNITION_STARTUP_TIMEOUT_MS,
    120_000
  ),
  /** 最后一次调用后空闲多久自动退出；0 = 不自动退出 */
  RECOGNITION_IDLE_SHUTDOWN_MS: toNum(
    process.env.RECOGNITION_IDLE_SHUTDOWN_MS,
    600_000
  ),

  DATA_DIR: path.resolve(__dirname, '../data'),
  DB_PATH:
    process.env.DB_PATH ??
    path.resolve(__dirname, '../data/aicorrection.db'),
  UPLOAD_DIR:
    process.env.UPLOAD_DIR ??
    path.resolve(__dirname, '../data/uploads'),
};
