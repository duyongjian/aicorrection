/**
 * 归因 / 追问 Prompt 模板（ATT-01）
 * 统一输出格式约定：错因 / 知识点 / 本质 三行，便于解析与缺项判定。
 * [FOLLOWUP_MODE] 为 Mock 分支哨兵。
 */
import type { AttributionReference, AttributionWebSearch } from '@aicorrection/shared';

export const ATTR_SYSTEM = `你是一名资深学科诊断教练，擅长"触及本质"的错因诊断。请基于题干（及可选作答）输出恰好三行结构化诊断。

【硬约束·最高优先级】
只输出以下三行，禁止任何前言、推导过程、解释或多余文字：
错因：<一句话指出真正的错误根源>
知识点：<结构化的核心知识点>
本质：<一句话说明为什么错>

【要求】
- 三者必填且非空。
- 数学公式一律用 LaTeX：行内 $...$，独立公式 $$...$$ 独占一行；禁用纯文本数学符号（∂ ∫ ∑ − ≥ 等）。
- 错因须从题干与作答严谨推导（如漏链式法则系数、符号错、漏约分、端点未比较、概念混淆）。
- 若题干正确或无法定位错因，如实写：错因：解法正确，未出现错误 / 错因：未提供作答，无法定位具体错因；切勿臆造。
- 只可基于"本题题干+本题作答"独立推导，严禁凭空臆造条件、步骤或结论。
- 若给出【题库参考】/【网络检索参考】，仅作对照，须独立推导、不得照抄，无关则忽略。`;

/**
 * 无作答讲解模式（ATT-01b）：仅提供题干、未提供用户作答时，无法定位"具体错因"，
 * 转而输出"本题讲解"——正确答案 + 正确推导 + 常见陷阱（+ 知识点/本质 与诊断模式对齐）。
 * 同样硬性约束只输出带标记段落，禁止前言/推导噪音，以防 27B 模型长篇跑飞被截断。
 */
export const ATTR_SYSTEM_NOANSWER = `你是一名资深学科讲师，擅长"讲清一道题"。用户只给了题干、未给作答，因此你无法定位个人错因，应给出本题规范讲解。

【硬约束·最高优先级】
只输出以下带标记段落，每段独立成行，禁止任何前言、推导噪音或多余文字：
正确答案：<本题正确结论>
正确推导：<3-5 步最简推导，每步一行>
常见陷阱：<本题最易错点 1-2 条，具体到题型>
知识点：<本题核心知识点一句话>
本质：<一句话触及知识点本质>

【要求】
- 五段必填且非空；若题干不足以判定唯一答案，在"正确答案"中如实说明并给给定条件下结论。
- 数学公式一律用 LaTeX：行内 $...$，推导每步 $$...$$ 独占一行；禁用纯文本数学符号（∂ ∫ ∑ − ≥ 等）。
- 推导须独立自洽、仅基于题干，不引入未给条件；常见陷阱须具体到本题型，严禁空话。
- 只可基于题干独立推导，严禁臆造；若给参考块，仅对照、不得照抄，无关则忽略。
- 若题干给出 A/B/C/D 等选项：你必须在"正确答案"中明确写出正确选项字母（如"（D）"）及其结论，并回读"正确推导"末步，确认该结论与推导一致——尤其核对正负号、加减号、分母符号、指数是否抄错；不得臆造题干不存在的选项字母。若推导结论无法对应任一给定选项，如实写"无法对应给定选项"，切勿硬套字母。`;

export const FOLLOWUP_SYSTEM = `[FOLLOWUP_MODE] 你是苏格拉底式追问教练。针对用户对已归因结果的追问，给出一步更深层的补充归因解读（1-3 句），引导用户从"为什么"出发再拆解，而非直接给答案。`;

/** 诊断模式 user 消息尾（与 promptVariants 共用，确保 A/B 时只有 system 是变量） */
export const ATTR_TAIL_DIAGNOSE =
  '请聚焦识别真实存在的具体错因，克制推导篇幅，最终务必输出三行结论（错因/知识点/本质）。\n请按格式输出诊断：';

/** 讲解模式 user 消息尾（同上） */
export const ATTR_TAIL_TEACH =
  '请按讲解模式输出 正确答案 / 正确推导 / 常见陷阱 / 知识点 / 本质 五段，正确推导每步用 $$ 包裹并独占一行。\n直接输出，不要前言与总结：';

export function attrUserPrompt(
  question: string,
  userAnswer?: string,
  referenceBlock?: string,
  opts?: { teach?: boolean }
): string {
  const ansPart = userAnswer && userAnswer.trim()
    ? `\n用户作答：${userAnswer.trim()}`
    : '';
  // 题库参考块（P1）：独立 delimited 块，置于题干/作答之后。
  // 即便注入参考，也不污染最终三行结论（块内不使用契约标记词，见 buildReferenceBlock）。
  const refPart = referenceBlock && referenceBlock.trim()
    ? `\n\n${referenceBlock}`
    : '';
  const tail = opts?.teach ? ATTR_TAIL_TEACH : ATTR_TAIL_DIAGNOSE;
  return `题干：\n${question.trim()}${ansPart}${refPart}\n${tail}`;
}

/**
 * 把题库 RAG 检索结果渲染为"参考块"文本，注入到 user 消息（P1）。
 *
 * 渲染约束（任务硬要求）：
 *  - 块内**不得**出现契约标记词 错因/错误原因/知识点/本质，避免污染 parseAttrTriple
 *    （解析只针对模型输出文本，但为避免模型把参考当结论照搬，亦禁用标记词作标签）。
 *  - 明确告知模型：不得照抄其答案作为本题结论；须基于本题干独立推导；无关则忽略。
 *  - 仅当 status==='ok' 且含条目时才渲染；其余（empty/unavailable）返回空串（不注入）。
 *
 * 注意：展示标签用"考点"而非"知识点"，正是为了规避契约标记词。数据字段
 * knowledge_point 是英文标识符，不进入展示文本。
 */
export function buildReferenceBlock(ref: AttributionReference): string {
  if (ref.status !== 'ok' || ref.items.length === 0) return '';
  const lines: string[] = [];
  lines.push('【题库参考（相似题诊断要点，仅供对照，非本题答案）】');
  for (const it of ref.items) {
    lines.push(`- [${it.item_id}] 考点：${it.knowledge_point}`);
    lines.push(`  参考要点：${it.snippet}`);
  }
  lines.push(
    '要求：以上为相似题的参考诊断要点，仅供你对照参考。你不得原样照抄其答案作为本题结论；本题结论必须基于本题干与作答独立推导；若以上参考与本题无关，请完全忽略。'
  );
  return lines.join('\n');
}

/**
 * 把联网搜索结果渲染为"参考块"文本，注入到 user 消息（P2）。
 *
 * 与题库参考块同约束：
 *  - 不出现契约标记词（错因/错误原因/知识点/本质），避免污染最终三行解析；
 *  - 明确告知模型：不得照抄作为本题结论；须基于本题干独立推导；无关则忽略。
 *  - 仅当 status==='ok' 且含条目时渲染；其余返回空串（不注入）。
 *
 * 说明：网络资料可能含错误或不严谨内容，故措辞上更强调"仅供参考、必须独立验证"。
 * 展示标签用"网络检索参考"，不进契约标记词。
 */
export function buildWebSearchBlock(ref: AttributionWebSearch): string {
  if (ref.status !== 'ok' || ref.items.length === 0) return '';
  const lines: string[] = [];
  lines.push('【网络检索参考（公开资料要点，仅供参考，非本题答案）】');
  for (const it of ref.items) {
    lines.push(`- ${it.title}`);
    if (it.snippet) lines.push(`  摘要：${it.snippet}`);
    if (it.url) lines.push(`  来源：${it.url}`);
  }
  lines.push(
    '要求：以上为公开网络资料的检索要点，仅供参考。你必须基于本题干与作答独立推导，对网络内容需自行判断正确性，不得原样照抄其结论；若检索内容与本题无关，请完全忽略。'
  );
  return lines.join('\n');
}

export function followupUserPrompt(message: string, originalAttribution?: string): string {
  const ctx = originalAttribution
    ? `\n（原归因：${originalAttribution}）`
    : '';
  return `用户追问：${message.trim()}${ctx}`;
}

export interface ParsedTriple {
  cause?: string;
  knowledge_point?: string;
  essence?: string;
  hasThree: boolean;
}

/** 无作答讲解模式解析结果：正确答案 / 正确推导 / 常见陷阱 为核心字段。 */
export interface ParsedTeaching {
  correct_answer?: string;
  derivation?: string;
  pitfalls?: string;
  knowledge_point?: string;
  essence?: string;
  hasCore: boolean;
}

/** 已知字段标记（含别名），用于在同一行/多行输出中切分三段。 */
const FIELD_MARKERS = ['错因', '错误原因', '知识点', '本质', '正确答案', '正确推导', '常见陷阱'];

/**
 * 解析 LLM / Mock 输出为三项结构；三项齐全返回 hasThree=true。
 * 兼容两类常见输出：
 *  - 多行：每行一个 "错因：..." / "知识点：..." / "本质：..."
 *  - 单行：三段以空格或标点拼接（小参数模型常见）
 *
 * 推理类本地模型（MiniCPM-V-4.5 等）会把答案放在 reasoning_content，
 * 且前面夹杂大量"思考噪音"、可能中途复读 错因/知识点/本质 标记。
 * 因此解析以"最后一个 本质"为锚点，向前回溯 知识点、错因，
 * 只取结尾那段连续、完整的三行结论，避免思考噪音污染结果。
 */
export function parseAttrTriple(text: string): ParsedTriple {
  const src = text.replace(/\r/g, '').trim();
  const essence = findLastField(src, ['本质'], null);
  const knowledge_point = essence ? findLastField(src, ['知识点'], essence.index) : undefined;
  const cause = knowledge_point ? findLastField(src, ['错因', '错误原因'], knowledge_point.index) : undefined;
  const hasThree = Boolean(
    cause && knowledge_point && essence &&
    cause.value && knowledge_point.value && essence.value
  );
  return {
    cause: cause?.value,
    knowledge_point: knowledge_point?.value,
    essence: essence?.value,
    hasThree,
  };
}

/**
 * 解析无作答讲解模式的输出：提取 正确答案 / 正确推导 / 常见陷阱（核心三段）
 * 以及可选的 知识点 / 本质。以"最后一个标记"为锚（兼容推理模型在 reasoning 后输出结论）。
 * 核心三段齐全返回 hasCore=true。
 */
export function parseTeaching(text: string): ParsedTeaching {
  const src = text.replace(/\r/g, '').trim();
  const correct_answer = findLastField(src, ['正确答案'], null)?.value;
  const derivation = findLastField(src, ['正确推导'], null)?.value;
  const pitfalls = findLastField(src, ['常见陷阱'], null)?.value;
  const knowledge_point = findLastField(src, ['知识点'], null)?.value;
  const essence = findLastField(src, ['本质'], null)?.value;
  const hasCore = Boolean(correct_answer && derivation && pitfalls);
  return { correct_answer, derivation, pitfalls, knowledge_point, essence, hasCore };
}

interface FoundField { value: string; index: number; }

/**
 * 讲解模式答案-选项一致性校验（质量闸门，强化版）。
 * 不仅检查"指名的选项字母存在"，还核对"该字母对应选项的公式"是否与模型给出的正确公式一致：
 *  - 指名字母的公式与模型公式一致 → 通过；
 *  - 指名字母不一致、但其他某选项公式与模型公式一致 → 模型标错字母，自动纠正为正确字母；
 *  - 指名字母本身不在题干选项中、且公式也不命中任一选项 → 答案与选项对不上，降级 incomplete；
 *  - 题干无选项 / 答案未指名字母 / 公式归一化后无冲突但亦无命中 → 放行（避免符号记法漂移误杀）。
 */
export interface AnswerLetterCheck {
  /** false → 调用方应降级为 incomplete（答案无法与选项对齐）。 */
  ok: boolean;
  /** 若模型标错了字母但公式命中了别的选项，返回修正后的"正确答案"文本。 */
  correctedText?: string;
}

/** 题干选项解析：抽取 (A)...(B)... 标号与选项体（含公式）。 */
interface ParsedOption {
  letter: string;
  body: string;
}
function parseOptions(question: string): ParsedOption[] {
  const markerRe = /[\(（]\s*([A-Ea-e])\s*[\)）]/g;
  const markers: { letter: string; idx: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(question)) !== null) {
    markers.push({ letter: m[1].toUpperCase(), idx: m.index });
  }
  if (markers.length === 0) return [];
  const opts: ParsedOption[] = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].idx;
    const end = i + 1 < markers.length ? markers[i + 1].idx : question.length;
    opts.push({ letter: markers[i].letter, body: question.slice(start, end).trim() });
  }
  return opts;
}

/** 公式归一化：去空白、统一减号/括号、去 LaTeX 装饰，便于结构化比对。 */
function normalizeFormula(f: string): string {
  return (f ?? '')
    .replace(/\s+/g, '')
    .replace(/[−–—]/g, '-') // 各种 dash → ASCII 减号
    .replace(/[＼\\]/g, '') // 去掉反斜杠
    .replace(/[{}]/g, '') // 去 LaTeX 花括号
    .replace(/\\?frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)') // \frac{a}{b} → (a)/(b)
    .replace(/\$/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .toLowerCase();
}

/** 从"正确答案"段抽取公式：去掉开头字母标记，取标记后整段（截掉末尾解释性文字）。 */
function extractFormula(text: string): string {
  let s = (text ?? '')
    .replace(/^[\(（]\s*[A-Ea-e]\s*[\)）]\s*[:：]?/, '')
    .replace(/^选项?[A-Ea-e]\s*[:：]?/i, '')
    .trim();
  // 截掉末尾可能的解释性文字（句号 / 中文或英文括号之后不再属于公式本体）
  const cut = s.search(/[。.（(]/);
  if (cut > 0) s = s.slice(0, cut);
  return normalizeFormula(s);
}

/** 抽取"正确答案"段里指名的选项字母。 */
function extractClaimedLetter(text: string): string | null {
  const claimRe =
    /[\(（]\s*([A-Ea-e])\s*[\)）]|选[择]?\s*([A-Ea-e])\b|选项\s*([A-Ea-e])\b|([A-Ea-e])\s*项\b/g;
  let m: RegExpExecArray | null;
  let claimed: string | null = null;
  while ((m = claimRe.exec(text)) !== null) {
    claimed = (m[1] || m[2] || m[3] || m[4]).toUpperCase();
  }
  return claimed;
}

export function verifyAnswerLetter(
  correctAnswer: string | undefined,
  question: string
): AnswerLetterCheck {
  if (!correctAnswer) return { ok: true };
  const opts = parseOptions(question);
  if (opts.length === 0) return { ok: true }; // 题干无选项，跳过校验

  const claimed = extractClaimedLetter(correctAnswer);
  if (!claimed) return { ok: true }; // 答案未指名字母，放行

  const answerFormula = extractFormula(correctAnswer);
  if (!answerFormula) return { ok: true };

  const stripMarker = (body: string) => body.replace(/^[\(（]\s*[A-Ea-e]\s*[\)）]\s*/, '');
  const claimedOpt = opts.find((o) => o.letter === claimed);
  const claimedNorm = claimedOpt ? normalizeFormula(stripMarker(claimedOpt.body)) : '';

  // 1) 指名字母自身公式一致 → 通过
  if (claimedNorm && claimedNorm === answerFormula) return { ok: true };

  // 2) 在其他选项中找公式命中的字母 → 模型标错字母，自动纠正
  const hit = opts.find(
    (o) => o.letter !== claimed && normalizeFormula(stripMarker(o.body)) === answerFormula
  );
  if (hit) {
    const correctedText = correctAnswer.replace(
      new RegExp(`([\\(（]\\s*)${claimed}(\\s*[\\)）])`, 'g'),
      `$1${hit.letter}$2`
    );
    return { ok: true, correctedText };
  }

  // 3) 指名字母本身不在题干选项中、且公式也无命中 → 臆造/对不上，降级
  if (!claimedOpt) return { ok: false };
  // 4) 指名字母在选项中但公式无命中、也无其他命中 → 放行（记法漂移保护，不误杀）
  return { ok: true };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构造「字段标记」匹配正则。两种合法形态：
 *  A. 行内带冒号：`正确推导：...` / `正确推导: ...`（v0.1 契约，原样保留）
 *  B. 标记单独成行、冒号省略：`正确推导\n$$...$$`（Qwen3.5-9B 等模型高频出现，
 *     见 docs/k1.5-G1闸门报告框架.md §4.5 / §4.6）
 *
 * 分支 B 刻意要求「整行除标记外只有空白/装饰」，避免把正文里顺带提到
 * 「以下给出正确推导的思路」这类句子误判成标题而切断字段值。
 * 装饰允许 markdown 强调符、列表符与序号；行首装饰不使用 \s，以免跨行吞掉换行
 * （分支 A 仍保留原有的 \s*，逐字维持旧行为）。
 */
function buildFieldRegex(labels: string[]): RegExp {
  const alt = labels.map(escapeRegExp).join('|');
  const deco = '[ \\t>*\\-–—\\d.、（）()]';
  const lineHeading = `^${deco}*(?:${alt})${deco}*[:：]?[ \\t]*$`;
  const inlineColon = `(?:${alt})\\s*[:：]`;
  return new RegExp(`${lineHeading}|${inlineColon}`, 'gm');
}

/**
 * 在 [0, beforeIndex) 范围内找最后一个 label 标记（如 "错因："/"错因:"，
 * 或单独成行的 "错因"），取其值为其后文本直到下一个已知标记或文末。
 * beforeIndex 用于"向前回溯"锚定同一结论块，过滤掉更靠后的思考噪音。
 *
 * 注意：切分结束位置必须使用与标记识别**同一套**正则。否则无冒号标题虽被识别，
 * 其后的 "常见陷阱：" 仍会被吞进 derivation，导致核心三段判不全、字段互相污染。
 */
function findLastField(text: string, labels: string[], beforeIndex: number | null): FoundField | undefined {
  const anyMarker = buildFieldRegex(FIELD_MARKERS);
  let best: FoundField | null = null;
  for (const label of labels) {
    const re = buildFieldRegex([label]);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (beforeIndex !== null && m.index >= beforeIndex) break;
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const after = text.slice(m.index + m[0].length);
      anyMarker.lastIndex = 0;
      const p = anyMarker.exec(after);
      const end = p ? p.index : after.length;
      const value = after.slice(0, end).trim();
      if (value) best = { value, index: m.index };
    }
  }
  return best ?? undefined;
}
