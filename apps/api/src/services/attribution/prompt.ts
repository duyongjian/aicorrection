/**
 * 归因 / 追问 Prompt 模板（ATT-01）
 * 统一输出格式约定：错因 / 知识点 / 本质 三行，便于解析与缺项判定。
 * [FOLLOWUP_MODE] 为 Mock 分支哨兵。
 */
import type { AttributionReference, AttributionWebSearch } from '@aicorrection/shared';

export const ATTR_SYSTEM = `你是一名资深学科诊断教练，擅长"触及本质"的错因诊断（而非浅标签）。
请基于题干（及可选的用户作答）输出三项结构化诊断。

最终结论必须严格使用如下三行格式，并放在整段回答的最后（前面不要重复书写这三个标记）：
错因：<一句话指出真正的错误根源>
知识点：<结构化的核心知识点>
本质：<一句话触及该知识点本质，说明为什么错>

约束：
- 只输出这三行作为最终结论，不要附加任何解释性文字。
- 不论中间如何推导，最终三行必须完整且互不缺失（错因/知识点/本质 缺一不可）。
- 错因必须是能从题干与作答中严谨推导出的、具体的错误（如链式法则漏系数/未套公式、符号错误、约分或公因式未约、闭区间端点未比较、概念混淆等）。
- 若题干本身正确无误，或无法定位具体错因，请如实说明（例如 错因：解法正确，未出现错误），不要臆造或强行归因。
- "本质"所陈述的因果关系必须与数学推导一致；不要引入题干未要求、且对出错并不必要的臆想步骤（例如凭空说"未用原方程替换某项"，而该项在运算中会自然消去）。
- 推导从简：只做最简核对即可，切勿展开长篇推导挤占结论；最终三行必须出现在回答末尾，不得因推理过长而省略。
- 防臆造（刚性）：你只能基于"本题题干 + 本题用户作答"进行独立推导，严禁凭空臆造题干未给出的条件、步骤或结论。
- 关于【题库参考】：它只是相似题的参考诊断要点，仅供你对照思路；你必须基于本题干独立推导，不得将其中的结论直接挪作本题答案；若该参考与本题无关，应完全忽略，绝不为"套用参考"而曲解本题。`;

export const FOLLOWUP_SYSTEM = `[FOLLOWUP_MODE] 你是苏格拉底式追问教练。针对用户对已归因结果的追问，给出一步更深层的补充归因解读（1-3 句），引导用户从"为什么"出发再拆解，而非直接给答案。`;

export function attrUserPrompt(
  question: string,
  userAnswer?: string,
  referenceBlock?: string
): string {
  const ansPart = userAnswer && userAnswer.trim()
    ? `\n用户作答：${userAnswer.trim()}`
    : '';
  // 题库参考块（P1）：独立 delimited 块，置于题干/作答之后。
  // 即便注入参考，也不污染最终三行结论（块内不使用契约标记词，见 buildReferenceBlock）。
  const refPart = referenceBlock && referenceBlock.trim()
    ? `\n\n${referenceBlock}`
    : '';
  return `题干：\n${question.trim()}${ansPart}${refPart}\n请聚焦识别真实存在的具体错因，克制推导篇幅，最终务必输出三行结论。\n请按格式输出诊断：`;
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

/** 已知字段标记（含别名），用于在同一行/多行输出中切分三段。 */
const FIELD_MARKERS = ['错因', '错误原因', '知识点', '本质'];

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

interface FoundField { value: string; index: number; }

/**
 * 在 [0, beforeIndex) 范围内找最后一个 label 标记（如 "错因："/"错因:"），
 * 取其值为其后文本直到下一个已知标记或文末。
 * beforeIndex 用于"向前回溯"锚定同一结论块，过滤掉更靠后的思考噪音。
 */
function findLastField(text: string, labels: string[], beforeIndex: number | null): FoundField | undefined {
  let best: FoundField | null = null;
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:：]`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (beforeIndex !== null && m.index >= beforeIndex) break;
      const after = text.slice(m.index + m[0].length);
      let end = after.length;
      for (const marker of FIELD_MARKERS) {
        const p = new RegExp(`\\s*${marker}\\s*[:：]`).exec(after);
        if (p && p.index < end) end = p.index;
      }
      const value = after.slice(0, end).trim();
      if (value) best = { value, index: m.index };
    }
  }
  return best ?? undefined;
}
