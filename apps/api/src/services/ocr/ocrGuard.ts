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
  '若它属于「需要转写的学术 / 数学内容」——包括含题干与选项的习题、公式题、试卷或作业截图，以及**仅含公式、等式或数学表达式的图**（例如只有算式、或带有已知答案的式子，如 ∫₀^∞ e^(−x²) dx = √π/2）——请逐字转写：完整保留题干、所有公式 / 等式与所有选项（A/B/C/D 等），不得省略、不得改写，不要解释、不要作答。\n' +
  `若图片「不是学术 / 数学内容」（如海报、广告、风景照、纯文字说明、收据、聊天截图、涂鸦、二维码、商品图等），请只输出「非题目」三个字（或 ${OCR_REJECT_TOKEN}），不要输出任何其它文字，也不要加括号或说明。`;

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
