/**
 * 公式 LaTeX 合并前校验（防止臆造 LaTeX 污染归因输入）
 *
 * 背景（实测证据，2026-10-28）：
 * PP-FormulaNet-S 对**不含公式**的图也会强行输出"识别结果"，且 score 恒为 1.0：
 *   - 促销图 ch_en_num.jpg     → 1035 字符臆造 LaTeX（\mathrm ×31、\scriptstyle×31，畸形 `\ ` / `{}`）
 *   - 纯文字题图（政治题干）  → 2065 字符臆造 LaTeX（\mathrm ×79、\scriptstyle×80）
 * 直接以【公式】拼进 question 会带偏归因 prompt，影响 M1 闸门 approval_rate。
 *
 * 判据设计原则（重要，基于复现数据的结论）：
 *   拒绝的代价是丢内容，误放的代价是污染输入。
 *   **绝对不能**用"绝对长度"当判据——真实错题的多行推导（矩阵演算、分段函数、
 *   三重积分、偏导/傅里叶推导）本就轻易超过几百甚至上千字符，按长度砍会误杀真公式，
 *   而数学题的公式恰恰是题干主体。
 *
 * 复现两张真图后统计（len / strong / \mathrm，strong=带 \b 的 \scriptstyle|\cal|\textbf|\mathit）：
 *   垃圾1 促销图   1035 / 31 / 31
 *   垃圾2 纯文字题图 2065 / 79 / 79
 *   真公式 F1 短    67 /  0 /  0
 *   真公式 F2 求导  356 /  0 / 10
 *   真公式 F3 三重积分 385 / 0 /  9
 *   真公式 F4 偏导推导 539 /  0 / 11
 *
 * 关键结论（数据驱动，非拍脑袋）：
 *   1) **\mathrm 分布无区分度**：垃圾每 ~26–33 字符 1 个，真公式每 ~36–49 字符 1 个，完全重叠。
 *      且 \mathrm{d}x / \mathrm{e} / \mathrm{i} 是 ISO 80000 推荐的正体排版（写得多=写得好）。
 *      → 所以 \mathrm 不能参与评分，否则只会误杀真公式；只留一个高位兜底闸。
 *   2) **strong token 是唯一有区分度的信号**：垃圾 31/79，真公式恒为 0。→ 主判据。
 *   3) **畸形空白/空组**是干净的第三道防线：垃圾密度 3.4~7.2，真公式 0.0，零重叠。
 *      → 兜住"没有 strong token 的臆造"。
 */

/** 最短可信长度（去掉空白后） */
export const MIN_LATEX_LEN = 3;
/**
 * 防跑飞上限：正常公式再长也到不了 5000 字符。
 * 这条**不是**"是不是垃圾"的判据，只是防止模型输出失控把 prompt 撑爆。
 */
export const RUNAWAY_LATEX_LEN = 5000;

/**
 * 主判据阈值：strong token（\scriptstyle / \cal / \textbf / \mathit）绝对数。
 * 真公式恒为 0，臆造样本 31 / 79，余量极大。8 是兼顾"偶发 1–2 个粘连漏计"的保守值。
 */
export const MAX_STRONG_TOKENS = 8;

/**
 * 第三道防线阈值：畸形空白 `\ `（转义空格）+ 空组 `{}` 的每 100 字符密度。
 * 实测：垃圾 3.4–7.2，真公式 0.0，零重叠。2.0 留足安全边际。
 */
export const MAX_MALFORMED_DENSITY = 2.0;

/**
 * \mathrm 纯兜底高位闸（不参与上述任何评分）。
 * 真实推导到不了 40；垃圾2 含 79 个，纯数值兜底挡住"无 strong token 的 \mathrm 洪水"。
 */
export const MAX_MATHRM = 40;

/**
 * 第四道防线：感叹号洪流（`!` / `\!` 重复）。
 * 背景（2026-11-02 实测）：PP-FormulaNet-S 在复杂数学图上会"跑飞"，吐出 `\!` 与 `!`
 * 成百上千次重复（如 `{\begin{array}...\frac{1}{a\ \!{\mathbb{H}}}\ \ !!!...`），既无 strong
 * token、也无 \mathrm 洪流、畸形密度也低，前三条判据全部漏过。正经数学 LaTeX 几乎不出现
 * `!`（仅阶乘 `n!` 与极少量 `\!` 间距），>8 即可判定跑飞。
 */
export const MAX_BANGS = 8;

/** 数学/LaTeX 结构信号：命中其一才认为"像公式" */
const MATH_SIGNAL_RE =
  /\\(?:frac|int|sqrt|sum|lim|pi|infty|partial|nabla|cdot|times|div|le|ge|neq|approx|bar|hat|vec|log|ln|sin|cos|tan|alpha|beta|theta|gamma|delta|Delta|mathbb|mathcal|text|mathrm|overline|underline|begin|end)|[_^]|\=/;

/**
 * 强垃圾信号：\scriptstyle / \cal / \textbf / \mathit
 * 在正常公式输出里极少出现，出现即为臆造特征。
 * 正则带 `\b`：避免把 `\mathcal` 误判为 `\cal`（cal 后紧跟 h 是词字符，无边界）。
 * 说明：垃圾里存在 `\scriptstylemathrm` / `\calcal` 这类粘连 token，`\b` 会少计 1–2 个，
 *      但垃圾基数 31/79 容错极大，不影响判定；去掉 `\b` 反而误伤 `\mathcal`，故保留。
 */
const STRONG_GARBAGE_RE = /\\(?:scriptstyle|cal|textbf|mathit)\b/g;
/** \mathrm 原始计数（仅用于兜底层与日志，不参与密度评分） */
const MATHRM_RE = /\\mathrm\b/g;
/** 畸形空白：转义空格 `\ ` */
const ESC_SPACE_RE = /\\ /g;
/** 畸形空组：`{}` 或 `{\s*}` */
const EMPTY_GROUP_RE = /\{\s*\}/g;

export type LatexRejectReason =
  | 'empty_or_too_short'
  | 'no_math_signal'
  | 'runaway_output'
  | 'garbage_token_flood'
  | 'malformed_syntax'
  | 'mathrm_flood'
  | 'exclamation_flood'
  | 'duplicate_of_text';

export interface LatexMetrics {
  len: number;
  /** 强信号计数：\scriptstyle|\cal|\textbf|\mathit */
  strong: number;
  /** \mathrm 原始计数（不减额度，不参与评分） */
  mathrm: number;
  /** 畸形 token 计数：`\ ` + `{}` */
  malformed: number;
  /** 每 100 字符的畸形密度 */
  malformedDensity: number;
  /** 感叹号（`!` 含 `\!` 中的 `!`）总数，用于第四道防线 */
  bangs: number;
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

/** 统计各垃圾信号计数 */
function scoreGarbage(latex: string): LatexMetrics {
  const strong = (latex.match(STRONG_GARBAGE_RE) ?? []).length;
  const mathrm = (latex.match(MATHRM_RE) ?? []).length;
  const malformed =
    (latex.match(ESC_SPACE_RE) ?? []).length +
    (latex.match(EMPTY_GROUP_RE) ?? []).length;
  const bangs = (latex.match(/!/g) ?? []).length;
  return {
    len: latex.length,
    strong,
    mathrm,
    malformed,
    malformedDensity: malformed / Math.max(1, latex.length / 100),
    bangs,
  };
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
  const m = scoreGarbage(latex);

  if (m.len < MIN_LATEX_LEN) {
    return { ok: false, latex, reason: 'empty_or_too_short', metrics: m };
  }
  if (!MATH_SIGNAL_RE.test(latex)) {
    return { ok: false, latex, reason: 'no_math_signal', metrics: m };
  }
  // 纯防跑飞兜底，不是垃圾判据
  if (m.len > RUNAWAY_LATEX_LEN) {
    return { ok: false, latex, reason: 'runaway_output', metrics: m };
  }
  // 主判据：强垃圾信号绝对数（真公式恒为 0，臆造 31/79）
  if (m.strong > MAX_STRONG_TOKENS) {
    return { ok: false, latex, reason: 'garbage_token_flood', metrics: m };
  }
  // 第三道防线：畸形空白/空组密度（真公式 0.0，臆造 3.4~7.2）
  if (m.malformedDensity > MAX_MALFORMED_DENSITY) {
    return { ok: false, latex, reason: 'malformed_syntax', metrics: m };
  }
  // \mathrm 纯兜底高位闸（不参与评分，仅挡无 strong token 的洪水）
  if (m.mathrm > MAX_MATHRM) {
    return { ok: false, latex, reason: 'mathrm_flood', metrics: m };
  }
  // 第四道防线：感叹号洪流（前三条判据对 `\!`/`!` 成百上千次重复无效）
  if (m.bangs > MAX_BANGS) {
    return { ok: false, latex, reason: 'exclamation_flood', metrics: m };
  }
  if (isDuplicateOfText(latex, ocrText)) {
    return { ok: false, latex, reason: 'duplicate_of_text', metrics: m };
  }
  return { ok: true, latex, metrics: m };
}
