/**
 * 归因 / 追问 Prompt 模板（ATT-01）
 * 统一输出格式约定：错因 / 知识点 / 本质 三行，便于解析与缺项判定。
 * [FOLLOWUP_MODE] 为 Mock 分支哨兵。
 */

export const ATTR_SYSTEM = `你是一名资深学科诊断教练，擅长"触及本质"的错因诊断（而非浅标签）。
请基于题干（及可选的用户作答）输出三项结构化诊断，严格使用如下格式（每行一个，冒号为中文全角）：
错因：<一句话指出真正的错误根源>
知识点：<结构化的核心知识点>
本质：<一句话触及该知识点本质，说明为什么错>
不要输出除上述三行以外的解释性文字。`;

export const FOLLOWUP_SYSTEM = `[FOLLOWUP_MODE] 你是苏格拉底式追问教练。针对用户对已归因结果的追问，给出一步更深层的补充归因解读（1-3 句），引导用户从"为什么"出发再拆解，而非直接给答案。`;

export function attrUserPrompt(question: string, userAnswer?: string): string {
  const ansPart = userAnswer && userAnswer.trim()
    ? `\n用户作答：${userAnswer.trim()}`
    : '';
  return `题干：\n${question.trim()}${ansPart}\n请按格式输出诊断：`;
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
 */
export function parseAttrTriple(text: string): ParsedTriple {
  const src = text.replace(/\r/g, '').trim();
  const cause = extractField(src, ['错因', '错误原因']);
  const knowledge_point = extractField(src, ['知识点']);
  const essence = extractField(src, ['本质']);
  const hasThree = Boolean(
    cause && knowledge_point && essence &&
    cause.length > 0 && knowledge_point.length > 0 && essence.length > 0
  );
  return { cause, knowledge_point, essence, hasThree };
}

/** 提取 "标记：值" 的值，直到下一个已知标记或文本结尾。 */
function extractField(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const startRe = new RegExp(`${label}\\s*[:：]`);
    const m = startRe.exec(text);
    if (!m) continue;
    const after = text.slice(m.index + m[0].length);
    let end = after.length;
    for (const marker of FIELD_MARKERS) {
      const p = new RegExp(`\\s*${marker}\\s*[:：]`).exec(after);
      if (p && p.index < end) end = p.index;
    }
    const value = after.slice(0, end).trim();
    if (value) return value;
  }
  return undefined;
}
