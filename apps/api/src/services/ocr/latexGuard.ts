/**
 * 公式 LaTeX 合并前校验（防止臆造 LaTeX 污染归因输入）
 *
 * 背景（实测证据，2026-10-28）：
 * PP-FormulaNet-S 对**不含公式**的图也会强行输出一段"识别结果"，且 score 恒为 1.0：
 *   - 促销图 ch_en_num.jpg  → 1035 字符臆造 LaTeX（\mathrm ×31）
 *   - 纯文字题图（政治题干）→ 2065 字符臆造 LaTeX（\mathrm ×79、\scriptstyle ×80）
 * 而真实公式（\int_0^\infty e^{-x^2}dx = \frac{\sqrt{\pi}}{2}）只有 67 字符、无垃圾标记词。
 *
 * 若不加校验直接以【公式】拼进 question，归因 prompt 会被垃圾串带偏，
 * 直接影响 M1 闸门 approval_rate。故合并前必须过这一道。
 *
 * 取舍原则：宁可漏掉公式，也不要把臆造 LaTeX 喂给归因。
 */

/** 最短可信长度（去掉空白后） */
export const MIN_LATEX_LEN = 3;
/** 最长可信长度：真公式实测 67 字符，臆造输出 1035/2065 字符 */
export const MAX_LATEX_LEN = 400;
/** 垃圾标记词出现次数上限（模型复读 \mathrm / \scriptstyle 即为臆造特征） */
export const MAX_GARBAGE_TOKENS = 8;

/** 数学/LaTeX 结构信号：命中其一才认为"像公式" */
const MATH_SIGNAL_RE =
  /\\(?:frac|int|sqrt|sum|lim|pi|infty|partial|nabla|cdot|times|div|le|ge|neq|approx|bar|hat|vec|log|ln|sin|cos|tan|alpha|beta|theta|gamma|delta|Delta|mathbb|mathcal|text|mathrm|overline|underline|begin|end)|[_^]|\=/;

/** 臆造特征标记词 */
const GARBAGE_TOKEN_RE = /\\(?:mathrm|scriptstyle|cal|textbf|mathit)\b/g;

export type LatexRejectReason =
  | 'empty_or_too_short'
  | 'no_math_signal'
  | 'too_long'
  | 'garbage_token_flood'
  | 'duplicate_of_text';

export interface LatexGuardResult {
  ok: boolean;
  /** 通过时返回规范化后的 LaTeX */
  latex: string;
  /** 未通过时的原因（用于 warn 日志） */
  reason?: LatexRejectReason;
  /** 未通过时的辅助信息 */
  detail?: string;
}

/** 去掉 LaTeX 命令与结构符号，得到"裸内容"用于与 OCR 文本比对 */
function stripLatexSyntax(s: string): string {
  return s
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/[{}\s$^_&\\]/g, '');
}

/** 去掉空白与标点，用于纯文本比对 */
function stripPlain(s: string): string {
  return s.replace(/[\s\p{P}\p{S}]/gu, '');
}

/**
 * 判断 LaTeX 是否只是把 OCR 已识别的文本重复了一遍
 * （例如文本入口已完整给出题干，再拼一段"公式"就是冗余）。
 */
function isDuplicateOfText(latex: string, ocrText: string): boolean {
  const plain = stripLatexSyntax(latex);
  const text = stripPlain(ocrText);
  if (plain.length < 3 || text.length < 3) return false;
  return text.includes(plain) || plain.includes(text);
}

/**
 * 校验一段 LaTeX 是否可信、可否拼进 question。
 * @param raw CLI 返回的 LaTeX 原文
 * @param ocrText 文本引擎已识别出的题干（用于去重判断）
 */
export function validateLatex(
  raw: string | null | undefined,
  ocrText: string
): LatexGuardResult {
  const latex = (raw ?? '').trim();

  if (latex.length < MIN_LATEX_LEN) {
    return { ok: false, latex, reason: 'empty_or_too_short' };
  }
  if (!MATH_SIGNAL_RE.test(latex)) {
    return { ok: false, latex, reason: 'no_math_signal' };
  }
  if (latex.length > MAX_LATEX_LEN) {
    return {
      ok: false,
      latex,
      reason: 'too_long',
      detail: `len=${latex.length} > ${MAX_LATEX_LEN}`,
    };
  }
  const garbage = (latex.match(GARBAGE_TOKEN_RE) ?? []).length;
  if (garbage > MAX_GARBAGE_TOKENS) {
    return {
      ok: false,
      latex,
      reason: 'garbage_token_flood',
      detail: `garbage_tokens=${garbage} > ${MAX_GARBAGE_TOKENS}`,
    };
  }
  if (isDuplicateOfText(latex, ocrText)) {
    return { ok: false, latex, reason: 'duplicate_of_text' };
  }
  return { ok: true, latex };
}
