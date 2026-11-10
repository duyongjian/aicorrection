/**
 * OCR 校验层（8090 视觉端 P0 修复）
 *
 * 背景：生产链路两点缺失——
 *  (a) OCR_PROMPT 只要求「仅输出题目正文」→ 选择题整块丢 4 个选项；
 *      且无「非题目拒识标记」指令 → 海报 / 广告被当题干一路进归因与错题本。
 *  (b) 链路无题目 / 拒识校验层：extractContent 后任何非空 content 原样透传。
 *
 * 本模块集中存放：OcrResult 类型、拒识哨兵、生产 prompt、合并前缀、拒识判定、
 * auto 分支三态决策与本地/视觉结果合并（mergeOcr 唯一来源），
 * 供 ocrService.ts 与 QA 复测脚本共同 import，避免脚本写死旧 prompt / token。
 * 纯函数、无副作用：不 import provider 单例 / env / DB；完全不依赖 ocrService。
 */
import type { OcrStatus } from '@aicorrection/shared';

/** OCR 结果类型（单一来源，从 ocrService.ts 原样迁入；QA 复测脚本也从本模块引用）。 */
export interface OcrResult {
  ocr_status: OcrStatus;
  question: string;
  /** 公式识别得到的 LaTeX（仅本地 paddle 公式分支产出，其余为 null） */
  latex?: string | null;
}

/** 非题目拒识标记：模型遇到海报 / 广告 / 风景 / 纯文字说明时只输出此串。 */
export const OCR_REJECT_TOKEN = '[[NOT_A_QUESTION]]';

/**
 * 生产 OCR prompt（替换旧「仅输出题目正文」）。
 * ① 逐字转写题干与所有选项（不得省略 / 改写）；② 非题目只输出拒识哨兵。
 */
export const OCR_PROMPT =
  '先判断这张图片的内容类型：\n' +
  '【转写】若图片主体是「面向学习的数学 / 题目内容」，请逐字转写：含题干与选项的习题、公式题；试卷 / 作业 / 练习册的照片或截图（内容为学生习题）；以及**仅含公式、等式或数学表达式的图**（如 ∫₀^∞ e^(−x²) dx = √π/2 这类只有算式、或带已知答案的式子）。完整保留题干、所有公式 / 等式与所有选项（A/B/C/D 等），不得省略、不得改写，不要解释、不要作答。\n' +
  `【拒识】若图片主体「不是学习类题目内容」，请只输出「非题目」三个字（或 ${OCR_REJECT_TOKEN}），不要输出任何其它文字：包括海报、广告、风景照、纯文字说明、商品图；**收据、发票、账单等日常单据（即使上面有金额数字，也不属于数学内容）**；聊天 / 网页 / UI 截图；涂鸦、二维码、条码。`;

/** 合并题干时本地 OCR 段的前缀（QA 复测据此构造合并后 question 形态）。 */
export const OCR_LOCAL_PREFIX = '【本地OCR识别】';
/** 合并题干时视觉模型段的前缀。 */
export const OCR_VISION_PREFIX = '【视觉模型描述(MiniCPM-V)】';

/**
 * 视觉识别结果三态：
 *  - unavailable：失败 / 不可达 / 超时 / mock / 空文本（上层静默保留本地结果，遗留风险）
 *  - rejected：模型明确判定「非题目」（上层必须覆盖本地结果为 fail，绝不 mock）
 *  - ok：拿到题目文本
 */
export type VisionOutcome =
  | { kind: 'unavailable' }
  | { kind: 'rejected' }
  | { kind: 'ok'; result: OcrResult };

/** 归一化：trim、折叠（去除）空白 / 换行、去首尾中英文引号。 */
function normalizeRejectText(text: string): string {
  let s = (text ?? '').replace(/\s+/g, '');
  const edgeQuotes = /^['"“”‘’「」『』]+|['"“”‘’「」『』]+$/g;
  let prev: string;
  do {
    prev = s;
    s = s.replace(edgeQuotes, '');
  } while (s !== prev);
  return s;
}

/**
 * 判定视觉模型输出是否为「非题目拒识」。
 *
 * 设计铁律：只对「整段就是拒识」或「以 token 开头的极短补充」判拒识，
 * 绝不对长文本做 substring 搜索（防误杀真实题干 / 选项 / 臆造 LaTeX）。
 * 归一化后长度 > 200 一律不判拒识。
 */
export function isRejectedOcrText(text: string): boolean {
  const s = normalizeRejectText(text);
  if (s.length === 0) return false; // 空串 / 纯空白：不判拒识，交上层 !text
  if (s.length > 200) return false; // 长文本守门：绝不 substring 误杀

  const lower = s.toLowerCase();
  const tokenLower = OCR_REJECT_TOKEN.toLowerCase();

  // ① 精确等于 token（大小写不敏感）
  if (lower === tokenLower) return true;
  // ② 裸「非题目」（允许末尾标点；引号已在归一化去除）
  if (/^非题目[。！!！.．,，、;；:：~～…·]*$/.test(s)) return true;
  // ③ 以 token 开头且总长 ≤ token.length + 20（容忍模型多说半句）
  if (lower.startsWith(tokenLower) && s.length <= OCR_REJECT_TOKEN.length + 20) {
    return true;
  }
  return false;
}

/**
 * 合并本地 OCR 与视觉大模型结果：二者拼接成同一题干，一起交给归因大模型交叉核对。
 * 本地 OCR 擅长精确字符（含公式块），视觉模型擅长整体语义/排版，互补可减少识别误差。
 * 由 ocrService.ts 原样迁入（行为一字不改，仅把两段前缀抽成常量），
 * 作为 auto 主路径合并逻辑的唯一来源，供 decideAutoOcrResult 与 QA 复测共用。
 */
export function mergeOcr(local: OcrResult, vision: OcrResult): OcrResult {
  const parts = [`${OCR_LOCAL_PREFIX}\n${local.question}`];
  if (vision.question.trim()) {
    parts.push(`${OCR_VISION_PREFIX}\n${vision.question.trim()}`);
  }
  return {
    ocr_status: local.ocr_status === 'success' ? 'success' : 'partial',
    question: parts.join('\n\n'),
    latex: local.latex ?? null,
  };
}

/**
 * auto 分支三态决策（OCR_COMBO=true 时叠加视觉第二路证据后调用）。
 *
 * rejected → 覆盖本地结果，整次识别返回 { ocr_status:'fail', question:'', latex:null }。
 *            绝不能 return local：默认 auto + COMBO 下本地 RapidOCR 对海报已识别出文字，
 *            若拒识只回退 unavailable，海报文字照样以 success 进归因（V4 仍漏）。
 * unavailable → 静默保留本地结果（沿用原有语义，登记为遗留风险）。
 * ok → 调用唯一来源的 mergeOcr 拼接本地 + 视觉两路文本。
 */
export function decideAutoOcrResult(
  local: OcrResult,
  outcome: VisionOutcome
): OcrResult {
  if (outcome.kind === 'rejected') {
    return { ocr_status: 'fail', question: '', latex: null };
  }
  if (outcome.kind === 'unavailable') {
    return local;
  }
  // ok：拒识判定已在 merge 之前逐源完成（recognizeVisionSafe），此处只做合并。
  return mergeOcr(local, outcome.result);
}

/**
 * 学术 / 题目信号检测（V4 收口的关键确定性兜底）。
 *
 * 背景：视觉模型对边界非题目（收据 / 发票 / 会议通知等）的拒识判定存在**采样非确定性**——
 * 同一张图同 prompt 可能一次拒识、一次转写（复验已实测 receipt_01 在 reject↔transcribe 间横跳）。
 * 仅靠模型单次吐「非题目」token 无法 100% 保证拒识，纯 prompt 调参已到天花板。
 *
 * 故在「软拒识 token」之外，增加**确定性内容闸门**：任何 success / partial 的题干文本，
 * 若不含任何学术 / 题目信号，一律确定性归为 fail（绝不进归因 / 错题本）。
 * 这是对原 P0 验收口径「(b) 加题目 / 拒识校验层」的落地——把拒识从「依赖模型单次决策」
 * 升级为「内容确定性判定」，从根上消除非确定性漏放。
 *
 * 设计铁律：只用**强学术信号**——中文题目词 / 结构数学符号 / 选项标号 / 变量数学语境；
 * **绝不用**裸数字、×、¥、% 作为信号（否则收据 / 账单会被误判为题目）。
 */
const ACADEMIC_WORD_RE =
  /(题目|习题|试题|解题|方程|等式|函数|求导|导数|积分|极限|矩阵|概率|极值|单调|数列|向量|微分|不等式|填空|选项|化简|比较|证明|已知|因为|所以|判断|选择)/;
const MATH_STRUCT_RE = /[∫√∑∏∂∇π∞≤≥≠≈²³¹⁰½¼¾±^]/;
const OPTION_RE = /[A-Ea-e][\.、)）]/;
const VAR_CONTEXT_RE = /[a-z]\s*[=+\-]|[=+\-]\s*[a-z]|[a-z]\(/;

export function hasAcademicSignal(text: string): boolean {
  const t = text ?? '';
  if (!t) return false;
  if (ACADEMIC_WORD_RE.test(t)) return true;
  if (MATH_STRUCT_RE.test(t)) return true;
  if (OPTION_RE.test(t)) return true;
  if (VAR_CONTEXT_RE.test(t)) return true;
  return false;
}

/**
 * 确定性拒识兜底：对 success / partial 结果，若题干无任何学术信号则强制 fail。
 * 已 fail 或空文本原样返回（含 rejected 路径，仍是 fail），幂等。
 */
/** 剥离本地 OCR / 视觉模型两段前缀行，仅对纯题目内容判定学术信号，避免「MiniCPM-V」里的 M- 被 VAR_CONTEXT_RE 误判为变量语境。 */
function stripOcrPrefixes(text: string): string {
  return (text ?? '')
    .split('\n')
    .filter(
      (line) =>
        !line.includes(OCR_LOCAL_PREFIX) && !line.includes(OCR_VISION_PREFIX)
    )
    .join('\n');
}

export function enforceAcademicSignal(result: OcrResult): OcrResult {
  if (result.ocr_status === 'fail') return result; // 已是 fail（含 rejected 路径），原样返回
  const q = (result.question ?? '').trim();
  if (!q) return { ocr_status: 'fail', question: '', latex: null };
  // 必须在剥离前缀后的纯内容判定：否则视觉前缀里的「M-」令任意转写文本恒有信号，闸门失效
  if (!hasAcademicSignal(stripOcrPrefixes(q))) {
    return { ocr_status: 'fail', question: '', latex: null };
  }
  return result;
}

/**
 * 本地 OCR 是否已充分捕捉题目信号，可确定性跳过视觉第二路（V5 时延优化，P1）。
 *
 * 判据（保守，避免误跳导致内容缺失）：
 *  - 本地结果必须是 success（非 partial / 空文本 / 未过学术闸门）；
 *  - 剥离前缀后的纯内容必须含学术信号（hasAcademicSignal 为真，等价于必然通过 enforceAcademicSignal）；
 *  - 且满足以下任一项：
 *      (1) 已抓全 ≥4 个选项标号（选择题本地已完整，视觉冗余）；
 *      (2) 含强数学结构符号（∫√∑∏∂∇π∞≤≥≠≈²³¹⁰½¼¾±^，纯公式 / 等式本地 paddle 分支已覆盖）。
 *  不满足上述任一条件时返回 false → 仍走视觉第二路做交叉核对。
 */
export function localIsSufficient(local: OcrResult): boolean {
  if (local.ocr_status !== 'success') return false;
  const content = stripOcrPrefixes(local.question ?? '');
  if (!hasAcademicSignal(content)) return false;
  // OPTION_RE 无 g 标志（hasAcademicSignal 用 .test 依赖其无状态），此处用全局副本统计全部选项标号
  const optCount = (content.match(new RegExp(OPTION_RE.source, 'g')) ?? []).length;
  if (optCount >= 4) return true;
  if (MATH_STRUCT_RE.test(content)) return true;
  return false;
}
