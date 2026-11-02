/**
 * OCR 服务（INF-04）
 *
 * 图片入口策略链（OCR_MODE）：
 *   llm   → 只用视觉大模型（原逻辑保留）
 *   local → 只用本地 OCR；失败即 ocr_status='fail'
 *   auto  → 优先本地 OCR（RapidOCR ~2.4s），失败降级视觉大模型
 *
 * 文本入口（text/paste）无需 OCR，直接复用原文，ocr_status='success'。
 */
import fs from 'node:fs';
import { getRecognitionProvider } from '../llm';
import { ensureRecognitionReady } from './recognitionAutostart';
import { MockProvider } from '../llm/mockProvider';
import { env } from '../../config/env';
import { MOCK_ATTR_MODEL_VERSION } from '@aicorrection/shared';
import type { OcrStatus } from '@aicorrection/shared';
import {
  runLocalOcr,
  type LocalOcrEngine,
} from './localOcrService';
import { validateLatex } from './latexGuard';
import { withTimeout } from '../../utils/promise';

export interface OcrResult {
  ocr_status: OcrStatus;
  question: string;
  /** 公式识别得到的 LaTeX（仅本地 paddle 公式分支产出，其余为 null） */
  latex?: string | null;
}

export interface RecognizeImageOpts {
  subject?: string;
  /** 仅用于日志定位：丢弃臆造 LaTeX 时打印，便于回溯是否误杀 */
  loopId?: string;
}

const OCR_PROMPT =
  '请将图片中的题目转为纯文本标准化题干，仅输出题目正文，不要解释、不要作答。';

/** 本地 OCR 文本引擎名（受 OCR_TEXT_ENGINE 配置约束） */
const TEXT_ENGINE: LocalOcrEngine = env.OCR_TEXT_ENGINE;

// ---- 公式触发判定（保守：避免每张图都多花 ~1.3s 还拿到垃圾 LaTeX）----

/** 命中即视为数学学科 */
const MATH_SUBJECT_KEYS = [
  'math',
  '数学',
  '高数',
  '高等数学',
  '线代',
  '线性代数',
  '概率',
  '概率论',
  '数理统计',
  '离散数学',
];

/** 公式符号（出现任一即触发，不必同时含数字） */
const MATH_SYMBOL_RE = /[∫√∑π±×÷≤≥≠≈∇∂^]/;
/** 中文数学词 */
const MATH_WORD_RE =
  /(求|解|证明|函数|方程|导数|积分|极限|矩阵|概率|极值|单调|数列|向量|微分|不等式)/;

/**
 * 判定是否值得再跑一次 Paddle 公式识别（PP-FormulaNet-S，~1.3s）。
 * 命中条件：学科是数学类，或文本含"= 且有数字"，或含公式符号，或含中文数学词。
 */
export function shouldTryFormula(subject?: string, text?: string): boolean {
  const s = (subject ?? '').toLowerCase();
  if (MATH_SUBJECT_KEYS.some((k) => s.includes(k))) return true;

  const t = text ?? '';
  if (!t) return false;
  const hasEqAndDigit = t.includes('=') && /\d/.test(t);
  return hasEqAndDigit || MATH_SYMBOL_RE.test(t) || MATH_WORD_RE.test(t);
}

/** 文本入口：原文即为题干，无需 OCR。 */
export function recognizeText(rawText?: string): OcrResult {
  const question = (rawText ?? '').trim();
  return {
    ocr_status: question ? 'success' : 'fail',
    question,
    latex: null,
  };
}

/** 图片入口：本地 OCR 优先，按 OCR_MODE 决定是否叠加/降级视觉大模型。 */
export async function recognizeImage(
  imagePath: string,
  opts: RecognizeImageOpts = {}
): Promise<OcrResult> {
  if (env.OCR_MODE === 'llm') {
    // 纯视觉大模型模式（含探活 + 可选 mock 兜底）
    return recognizeImageByLlm(imagePath);
  }
  if (env.OCR_MODE === 'local') {
    // 纯本地 OCR，不让步：本地失败（含未识别到文本）如实返回 fail，绝不抛 500。
    try {
      return await recognizeImageLocal(imagePath, opts);
    } catch {
      return { ocr_status: 'fail', question: '', latex: null };
    }
  }

  // auto（默认）：本地 OCR 优先；成功后再叠加视觉大模型描述（OCR_COMBO）做交叉核对。
  const local = await recognizeImageLocalSafe(imagePath, opts);
  if (!local) {
    // 本地完全失败（未识别到任何文本）→ 降级视觉大模型（内部含探活 + 可选 mock 兜底）
    const ready = await ensureRecognitionReady();
    if (!ready) return { ocr_status: 'fail', question: '', latex: null };
    return recognizeImageByLlm(imagePath);
  }
  if (env.OCR_COMBO) {
    // 视觉大模型作为第二路证据：成功则合并，失败则静默保留本地结果（绝不 mock）。
    const vision = await recognizeVisionSafe(imagePath).catch(() => null);
    if (vision) return mergeOcr(local, vision);
  }
  return local;
}

/** 本地 OCR 安全包装：任何异常（含未识别到文本）都返回 null，由上层决定降级策略。 */
async function recognizeImageLocalSafe(
  imagePath: string,
  opts: RecognizeImageOpts
): Promise<OcrResult | null> {
  try {
    return await recognizeImageLocal(imagePath, opts);
  } catch {
    return null;
  }
}

/**
 * 视觉大模型语义描述（MiniCPM-V 等），识别双通道的第二路证据。
 * 失败/不可达/超时 → 返回 null（不 mock、不抛错，由 mergeOcr 上层决定是否仍用本地结果）。
 */
async function recognizeVisionSafe(imagePath: string): Promise<OcrResult | null> {
  const ready = await ensureRecognitionReady();
  if (!ready) return null;
  const provider = getRecognitionProvider();
  const base64 = fs.readFileSync(imagePath).toString('base64');
  try {
    const res = await withTimeout(
      provider.chatWithImage(base64, OCR_PROMPT),
      env.OCR_LOCAL_TIMEOUT_MS
    );
    const text = (res.text ?? '').trim();
    if (!text) return null;
    return { ocr_status: 'success', question: text, latex: null };
  } catch {
    return null;
  }
}

/**
 * 合并本地 OCR 与视觉大模型结果：二者拼接成同一题干，一起交给归因大模型交叉核对。
 * 本地 OCR 擅长精确字符（含公式块），视觉模型擅长整体语义/排版，互补可减少识别误差。
 */
function mergeOcr(local: OcrResult, vision: OcrResult): OcrResult {
  const parts = [`【本地OCR识别】\n${local.question}`];
  if (vision.question.trim()) {
    parts.push(`【视觉模型描述(MiniCPM-V)】\n${vision.question.trim()}`);
  }
  return {
    ocr_status: local.ocr_status === 'success' ? 'success' : 'partial',
    question: parts.join('\n\n'),
    latex: local.latex ?? null,
  };
}

/**
 * 本地 OCR：① 文本引擎抽题干 → ②（可选）公式引擎抽 LaTeX → ③ 拼接。
 * 任一步失败都 throw，由 recognizeImage 统一处理降级。
 */
async function recognizeImageLocal(
  imagePath: string,
  opts: RecognizeImageOpts
): Promise<OcrResult> {
  const textRes = await runLocalOcr(imagePath, { engine: TEXT_ENGINE });
  const texts = textRes.texts
    .map((t) => (t.text ?? '').trim())
    .filter((t) => t.length > 0);
  const question = texts.join('\n');

  // 未识别到任何文本 → 如实抛错，交由上层降级（auto）/ fail（local），不放宽判定
  if (!question) {
    throw new Error(`本地 OCR（${TEXT_ENGINE}）未识别到任何文本`);
  }

  let latex: string | null = null;
  if (env.OCR_FORMULA_AUTO && shouldTryFormula(opts.subject, question)) {
    try {
      const f = await runLocalOcr(imagePath, {
        engine: 'paddle',
        formula: true,
      });
      const candidate = (f.texts[0]?.text ?? '').trim();
      if (candidate) {
        // PP-FormulaNet-S 对不含公式的图也会强行吐一段臆造 LaTeX（score 恒 1.0），
        // 故"拿到 LaTeX"不等于"该用"，必须过校验才允许拼进 question。
        const guard = validateLatex(candidate, question);
        if (guard.ok) {
          latex = guard.latex;
        } else {
          const m = guard.metrics;
          console.warn(
            `[ocr] 丢弃疑似臆造 LaTeX（不拼入 question）loop_id=${
              opts.loopId ?? '-'
            } reason=${guard.reason} len=${m.len} strong=${m.strong}` +
              ` mathrm=${m.mathrm} malformed=${m.malformed}` +
              ` malformedDensity=${m.malformedDensity.toFixed(2)}` +
              ` snippet=${JSON.stringify(candidate.slice(0, 80))}`
          );
        }
      }
    } catch {
      // 公式识别失败不阻断已拿到的题干文本
    }
  }

  return {
    ocr_status: 'success',
    // 让下游归因 prompt 能看到公式，否则公式识别白做
    question: latex ? `${question}\n【公式】${latex}` : question,
    latex,
  };
}

/** 视觉大模型图片识别（LLM 模式 / auto 降级路径，逻辑与改造前一致）。 */
async function recognizeImageByLlm(imagePath: string): Promise<OcrResult> {
  // 图片识别走识别 provider（LLM_* / VISION_*，仍指向 MiniCPM 等视觉模型）
  const provider = getRecognitionProvider();
  const base64 = fs.readFileSync(imagePath).toString('base64');
  try {
    const res = await provider.chatWithImage(base64, OCR_PROMPT);
    const isMock = provider.name === 'mock' || provider.name === MOCK_ATTR_MODEL_VERSION;
    const text = (res.text ?? '').trim();
    if (isMock) {
      // Mock 视觉模型：占位题干，标记 partial，闭环仍可继续演示
      return { ocr_status: 'partial', question: text, latex: null };
    }
    if (!text) {
      return { ocr_status: 'fail', question: '', latex: null };
    }
    return { ocr_status: 'success', question: text, latex: null };
  } catch {
    // 视觉模型不可用（如 VISION_MODEL 未拉取）→ Mock 占位题干兜底，保证图片入口仍可演示
    if (env.AUTO_FALLBACK_TO_MOCK) {
      const mock = new MockProvider();
      const r = await mock.chatWithImage(base64, OCR_PROMPT);
      return { ocr_status: 'partial', question: r.text, latex: null };
    }
    return { ocr_status: 'fail', question: '', latex: null };
  }
}
