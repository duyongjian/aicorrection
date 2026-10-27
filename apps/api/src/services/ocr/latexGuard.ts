/**
 * 公式 LaTeX 合并前校验（防止臆造 LaTeX 污染归因输入）
 *
 * 背景（实测证据，2026-10-28）：
 * PP-FormulaNet-S 对**不含公式**的图也会强行输出"识别结果"，且 score 恒为 1.0：
 *   - 促销图 ch_en_num.jpg  → 1035 字符臆造 LaTeX（\mathrm ×31）
 *   - 纯文字题图（政治题干）→ 2065 字符臆造 LaTeX（\mathrm ×79、\scriptstyle ×80）
 * 直接以【公式】拼进 question 会带偏归因 prompt，影响 M1 闸门 approval_rate。
 *
 * 判据设计原则（重要）：
 *   **拒绝的代价是丢内容，误放的代价是污染输入**。
 *   不用"绝对长度"当判据——真实错题的多行推导（矩阵演算、分段函数）本就轻易超过几百字符，
 *   按长度砍会误杀真公式，而数学题的公式恰恰是题干主体。
 *   真正要拦的是「\mathrm ×31 / \scriptstyle ×80 这种病态重复」，故按**垃圾标记词密度**判定。
 */

/** 最短可信长度（去掉空白后） */
export const MIN_LATEX_LEN = 3;
/**
 * 防跑飞上限：正常公式再长也到不了 5000 字符。
 * 这条**不是**"是不是垃圾"的判据，只是防止模型输出失控把 prompt 撑爆。
 */
export const RUNAWAY_LATEX_LEN = 5000;
/** 垃圾分绝对阈值 */
export const MAX_GARBAGE_SCORE = 8;
/** 垃圾分密度阈值：每 100 字符允许的垃圾分 */
export const MAX_GARBAGE_DENSITY = 1.0;
/**
 * 允许的正常 \mathrm 用法个数。
 * \mathrm 在真公式里是合法写法（\mathrm{d}x、\mathrm{e}），硬算垃圾会误伤，
 * 故仅对超出该数量的部分计分。
 */
export const ALLOWED_MATHRM = 5;

/** 数学/LaTeX 结构信号：命中其一才认为"像公式" */
const MATH_SIGNAL_RE =
  /\\(?:frac|int|sqrt|sum|lim|pi|infty|partial|nabla|cdot|times|div|le|ge|neq|approx|bar|hat|vec|log|ln|sin|cos|tan|alpha|beta|theta|gamma|delta|Delta|mathbb|mathcal|text|mathrm|overline|underline|begin|end)|[_^]|\=/;

/**
 * 强垃圾信号：\scriptstyle / \cal / \textbf / \mathit
 * 在正常公式输出里极少出现，出现即为臆造特征。
 * 注意 \b 保证不会误匹配 \mathcal（\cal 后紧跟 h，无词边界）。
 */
const STRONG_GARBAGE_RE = /\\(?:scriptstyle|cal|textbf|mathit)\b/g;
/** 弱垃圾信号：\mathrm 合法但会被模型病态复读，超出 ALLOWED_MATHRM 的部分才计分 */
const WEAK_GARBAGE_RE = /\\mathrm\b/g;

export type LatexRejectReason =
  | 'empty_or_too_short'
  | 'no_math_signal'
  | 'runaway_output'
  | 'garbage_token_flood'
  | 'garbage_density'
  | 'duplicate_of_text';

export interface LatexMetrics {
  len: number;
  /** 强信号计数 */
  strong: number;
  /** 弱信号计数（\mathrm 超出允许额度的部分） */
  weak: number;
  /** score = strong + weak */
  score: number;
  /** 每 100 字符的垃圾分 */
  density: number;
}

export interface LatexGuardResult {
  ok: boolean;
  /** 通过时返回规范化后的 LaTeX */
  latex: string;
  /** 未通过时的原因（用于 warn 日志） */
  reason?: LatexRejectReason;
  /** 判定过程中的量化指标，便于复查是否误杀 */
  metrics: LatexMetrics;
}

/** 统计垃圾标记词得分 */
function scoreGarbage(latex: string): Pick<LatexMetrics, 'strong' | 'weak' | 'score'> {
  const strong = (latex.match(STRONG_GARBAGE_RE) ?? []).length;
  const weak = Math.max(
    0,
    (latex.match(WEAK_GARBAGE_RE) ?? []).length - ALLOWED_MATHRM
  );
  return { strong, weak, score: strong + weak };
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
  const len = latex.length;
  const { strong, weak, score } = scoreGarbage(latex);
  const density = score / Math.max(1, len / 100);
  const metrics: LatexMetrics = { len, strong, weak, score, density };

  if (len < MIN_LATEX_LEN) {
    return { ok: false, latex, reason: 'empty_or_too_short', metrics };
  }
  if (!MATH_SIGNAL_RE.test(latex)) {
    return { ok: false, latex, reason: 'no_math_signal', metrics };
  }
  // 纯防跑飞兜底，不是垃圾判据
  if (len > RUNAWAY_LATEX_LEN) {
    return { ok: false, latex, reason: 'runaway_output', metrics };
  }
  // 绝对数判据：短串上也能兜住（密度判据在短串上分母小、不够稳）
  if (score > MAX_GARBAGE_SCORE) {
    return { ok: false, latex, reason: 'garbage_token_flood', metrics };
  }
  // 密度判据：每 100 字符垃圾分超过阈值即为病态重复
  if (density > MAX_GARBAGE_DENSITY) {
    return { ok: false, latex, reason: 'garbage_density', metrics };
  }
  if (isDuplicateOfText(latex, ocrText)) {
    return { ok: false, latex, reason: 'duplicate_of_text', metrics };
  }
  return { ok: true, latex, metrics };
}
