/**
 * 归因 / 追问 Prompt 模板（ATT-01）
 * 统一输出格式约定：错因 / 知识点 / 本质 三行，便于解析与缺项判定。
 * [FOLLOWUP_MODE] 为 Mock 分支哨兵。
 */
import type { AttributionReference, AttributionWebSearch } from '@aicorrection/shared';

export const ATTR_SYSTEM = `你是一名资深学科诊断教练，擅长"触及本质"的错因诊断（而非浅标签）。请基于题干（及可选的用户作答）输出三项结构化诊断。

【硬性输出约束（最高优先级）】
你的回答必须且只能包含恰好三行纯文本，格式严格如下，禁止输出任何推导过程、解释、前言、分析、思考、代码块或多余文字：
错因：<一句话指出真正的错误根源>
知识点：<结构化的核心知识点>
本质：<一句话触及该知识点本质，说明为什么错>
直接输出这三行即可，不要"好的，以下是…"之类开场白，也不要在行后追加说明。

【诊断要求】
- 三者缺一不可（错因/知识点/本质 必须都给出且非空）。
- 【数学表达】所有数学公式一律用 LaTeX 书写：行内公式用单个 $ 包裹（如 $\frac{\partial z}{\partial x}$），独立公式或关键等式用 $$ 包裹并独占一行（如 $$\frac{\partial z}{\partial x} - \frac{\partial z}{\partial y} = \frac{1}{a}$$）。禁止使用纯文本 unicode 数学符号（如 ∂、∫、∑、−、≥、¹⁄ₐ 等）代替 LaTeX。
- 错因须是从题干与作答中严谨推导出的具体错误（如链式法则漏系数/未套公式、符号错误、约分未约、端点未比较、概念混淆等）。
- 若题干本身正确无误或无法定位具体错因，请如实说明（例如 错因：解法正确，未出现错误 / 错因：未提供作答，无法定位具体错因），切勿臆造或强行归因。
- "本质"的因果关系必须与数学推导一致；不得引入题干未给出、且对出错并不必要的臆想步骤（例如凭空说"未用原方程替换某项"，而该项在运算中会自然消去）。
- 防臆造（刚性）：只可基于"本题题干 + 本题用户作答"独立推导，严禁凭空臆造题干未给出的条件、步骤或结论。
- 关于【题库参考】/【网络检索参考】：仅为相似题参考要点，须基于本题干独立推导，不得照抄其结论；若无关则完全忽略。`;

/**
 * 无作答讲解模式（ATT-01b）：仅提供题干、未提供用户作答时，无法定位"具体错因"，
 * 转而输出"本题讲解"——正确答案 + 正确推导 + 常见陷阱（+ 知识点/本质 与诊断模式对齐）。
 * 同样硬性约束只输出带标记段落，禁止前言/推导噪音，以防 27B 模型长篇跑飞被截断。
 */
export const ATTR_SYSTEM_NOANSWER = `你是一名资深学科讲师，擅长"讲清一道题"。当前用户只提供了题干、未提供自己的作答，因此你无法定位其个人错因，而应给出本题的规范讲解。

【硬性输出约束（最高优先级）】
你的回答必须且只能包含以下带标记段落，每段独立成行，禁止输出任何前言、解释、思考、代码块或多余文字：
正确答案：<本题正确结论；选择题直接写选项字母与等式，填空/解答题写最终表达式>
正确推导：<3-5 步最简推导，每步一行，不得展开长篇；只做抵达结论所需的最少步骤>
常见陷阱：<本题最容易错的点 1-2 条，具体到本类题型（如符号、漏项、混淆公式），不得空泛>
知识点：<本题涉及的核心知识点（一句话）>
本质：<一句话触及该知识点本质>

直接输出这五段即可，不要"好的，以下是…"之类开场白，也不要在段后追加说明。若题干不足以判定唯一答案，请在"正确答案"中如实说明并给出在给定条件下的结论。

【数学表达】
所有数学公式一律用 LaTeX 书写：行内公式用单个 $ 包裹（如 $F(x,y,z)=0$）；"正确推导"的每一步用 $$ 包裹并独占一行（如 $$z_x = -\frac{F_x}{F_z} = \frac{1}{a(1+e^{y+az})}$$）。禁止使用纯文本 unicode 数学符号（如 ∂、∫、∑、−、≥、¹⁄ₐ 等）代替 LaTeX，确保前端能渲染为可读公式。

【要求】
- 五段缺一不可（正确答案/正确推导/常见陷阱/知识点/本质 必须都给出且非空）。
- 正确推导须独立、自洽，仅基于题干，不引入题干未给的条件。
- 常见陷阱须具体到本题型（例如"对 e^{y+az} 关于 y 求偏导时漏掉内层 z 的链式法则，导致 z_y 符号错误"），严禁空话。
- 防臆造（刚性）：只可基于"本题题干"独立推导，严禁凭空臆造条件、步骤或结论。
- 关于【题库参考】/【网络检索参考】：仅为相似题参考要点，须基于本题干独立推导，不得照抄其结论；若无关则完全忽略。`;

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
