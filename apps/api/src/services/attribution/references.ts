/**
 * 归因知识锚点（grounding references）
 *
 * 背景：实测「非谓语动词（分词作状语）」知识点存在系统性错因误判（E03 类，
 * 约 40% 把"被动关系误判"错指成"悬垂结构/缺主语/缺有限动词"）。
 * 这里把该知识点的人工核查要点固化为"知识锚点"，在归因请求里作为 system 消息的
 * 补充上下文注入，引导模型先复核主谓语态，而非直接落到悬垂/缺主语类结论。
 *
 * 设计约束（来自任务硬要求）：
 *  - 锚点文本**不得**出现 `错因/知识点/本质` 四个标记词，避免污染 parseAttrTriple。
 *  - 锚点只在 system 消息里出现，模型输出解析只针对模型输出文本，互不干扰。
 *  - 非匹配学科（数学/政治/逻辑/高中等）必须零误触发，靠"英文分词语境"门控实现。
 */

export interface KnowledgeReference {
  id: string;
  /** 触发正则队列：首项不限学科；其余项需满足英文分词语境门控才生效。 */
  match: RegExp[];
  /** 注入给模型的 grounding 锚点文本（不含契约标记词）。 */
  anchor: string;
}

// 种子条目：非谓语动词（分词作状语）。结构留扩展位，后续可按知识点继续追加。
export const GOLD_REFERENCES: KnowledgeReference[] = [
  {
    id: 'kp-nonfinite-participle',
    match: [
      /分词|非谓语|participle/i,
      /seeing|seen|see|praising|praised|praise|reading|read|interested|interesting|walking|walked/i,
    ],
    anchor: `规则：分词（短语）作状语时，其逻辑主语就是主句主语，必须先判断主句主语与该动词是主动还是被动关系：
- 主语是动作的发出者（施事）→ 用现在分词（-ing，如 Seeing / Reading / Praising）；
- 主语是动作的承受者（受事）→ 用过去分词（-ed/过去分词，如 Seen / Read / Praised）。
易错陷阱：当主句已有明确主语时，错误几乎从来不是'悬垂结构/缺少主语/缺少有限动词'（那是分词逻辑主语缺失的情形）。若你的诊断落到'悬垂/缺主语/缺有限动词'，请先复核主谓关系与语态，确认是否其实是主动/被动判断失误。
范本：'Seen from the top of the hill, the city looks beautiful.' 中 city 是被看的对象（承受者），故用过去分词 Seen，而非 Seeing。`,
  },
  {
    id: 'kp-subject-verb-agreement',
    // 主触发（不限学科，安全：这些英文结构只出现在语法题，绝不出现于数/理/化）；
    // 中文 cue 作条件项，仅在英文分词语境下才生效，避免误触发。
    match: [
      /neither of|either of|each of|every one of|none of/i,
      /主谓一致|主谓搭配|单复数一致/i,
    ],
    anchor: `规则：以下不定代词作主语时，谓语用单数（is / was / has），不受 of 后复数名词影响：
- neither of + 复数名词 → 单数：Neither of the answers is correct.（不是 are / were）
- either of + 复数名词 → 单数：Either of the two books is fine.
- each of + 复数名词 → 单数：Each of the students was present.
- every one of + 复数名词 → 单数：Every one of them is ready.
判定方法：先确定真正主语是 neither / either / each / every（语义为单数），谓语必须用单数 is / was。若学生作答用的是 are / were / be（复数或原形），即为错误，应纠正为 is / was；不要因为 of 后跟着复数名词（如 answers / books / students）就认可复数谓语。
易错陷阱：学生常按"of 后就近的复数名词"判定主谓一致（例如看见 answers 就用 are），这是典型错误；真正主语是 neither / either / each / every（单数语义），谓语必须用单数。`,
  },
];

/** 题目是否处于"英文分词填空"语境：subject==='english'，或题目含英文字母且含下划线空 ___。 */
function isEnglishParticipleContext(question: string, subject?: string): boolean {
  if (subject === 'english') return true;
  const hasEnglish = /[a-zA-Z]/.test(question);
  const hasBlank = /_{2,}/.test(question);
  return hasEnglish && hasBlank;
}

/**
 * 按题干 + 作答匹配知识锚点。
 * 规则：
 *  - 首项正则（如 分词/非谓语/participle）不限学科，命中即触发；
 *  - 其余正则（如 seeing/seen 等英文分词词形）仅在"英文分词语境"下才允许命中，
 *    从而确保纯数学/政治等题（无英文填空）绝不会误触发。
 * @returns 命中的 anchor 数组（可多个；当前为 1）。
 */
export function getKnowledgeReferences(
  question: string,
  userAnswer?: string,
  subject?: string
): string[] {
  const haystack = `${question} ${userAnswer ?? ''}`.trim();
  const anchors: string[] = [];
  const ctx = isEnglishParticipleContext(question, subject);

  for (const ref of GOLD_REFERENCES) {
    const [primary, ...conditional] = ref.match;
    const primaryHit = primary.test(haystack);
    const conditionalHit =
      conditional.length > 0 && ctx && conditional.every((re) => re.test(haystack));
    if (primaryHit || conditionalHit) {
      anchors.push(ref.anchor);
    }
  }
  return anchors;
}
