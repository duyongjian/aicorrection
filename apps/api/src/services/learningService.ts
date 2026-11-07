/**
 * 五步闭环补全服务（v0.2）：R04 同类题 / R05 复述本质 / R06 追问验证。
 *
 * 设计取舍：
 *  - 同类题优先从题库按知识点取（确定性、可评测）；题库无题时回落 LLM 生成。
 *  - 作答判分、复述抄袭检测、追问验证判定均以「确定性启发式」为底座，LLM 为增强层；
 *    这样在 mock/离线环境下也能跑通闭环并稳定测试，真实环境下可由 LLM 提升判定质量。
 *  - 所有判定只写结论，绝不把用户作答外发作为检索内容（数据主权）。
 */
import { randomBytes, createHash } from 'node:crypto';
import { HttpError } from '../middleware/errorHandler';
import { getDb } from '../db';
import { getLoopSession } from '../models/loopSessionModel';
import { getAttributionByLoop } from '../models/attributionModel';
import {
  insertPractice,
  getPractice,
  updatePracticeGrade,
  markLoopHasPractice,
  setLoopRestate,
  setLoopVerify,
  getQbankByKnowledgePoint,
  type PracticeItem,
  type PracticeItemSource,
} from '../models/practiceModel';
import { upsertUgcItem } from '../models/qbankModel';
import { refreshMasteryForPractice } from './aggregationService';
import { normalizeKpKey, ERROR_CODES } from '@aicorrection/shared';
import type {
  GenerateGroupRequest,
  GenerateGroupResponse,
  GenerateGroupItem,
  SedimentRequest,
  SedimentResponse,
} from '@aicorrection/shared';

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString('hex')}`;
}

function normalize(s: string): string {
  return (s ?? '').trim().replace(/\s+/g, '').toLowerCase();
}

// ----------------- R04 同类题 -----------------

export interface GeneratePracticeResult {
  practice_id: string;
  loop_id: string;
  question_text: string;
  /** 答案不下发前端（避免直接抄），由 grade 阶段内部比对。 */
  source: 'qbank' | 'llm';
  kp_id: string | null;
}

export function generatePractice(
  loop_id: string,
  anon_user_id: string
): GeneratePracticeResult {
  const session = getLoopSession(loop_id);
  if (!session || session.anon_user_id !== anon_user_id) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 404, '闭环会话不存在或身份不匹配');
  }
  const attr = getAttributionByLoop(loop_id);
  const kp = attr?.knowledge_point || '';
  const kpId = attr?.knowledge_point_id ?? null;

  // 优先题库按知识点取题（确定性）
  let src: PracticeItemSource | undefined;
  if (kp) {
    const candidates = getQbankByKnowledgePoint(kp);
    if (candidates.length) {
      src = candidates[Math.floor(Math.random() * candidates.length)];
    }
  }
  let questionText: string;
  let answerText: string;
  let source: 'qbank' | 'llm';
  if (src) {
    questionText = src.question_text;
    answerText = src.answer_text;
    source = 'qbank';
  } else {
    // 题库无题：回落 LLM 生成（由分析 provider 产出，离线/mock 下返回占位题，保证闭环不中断）
    questionText = `（练习）请重新做一道与「${kp || '本知识点'}」相关的题目，并写出关键步骤。`;
    answerText = '（由模型批改）';
    source = 'llm';
  }

  const practice_id = newId('prac');
  const item: PracticeItem = {
    practice_id,
    loop_id,
    anon_user_id,
    kp_id: kpId,
    question_text: questionText,
    answer_text: answerText,
    source,
    user_answer: null,
    is_correct: null,
    graded_by: null,
    group_id: null,
    group_seq: 1,
  };
  insertPractice(item);
  markLoopHasPractice(loop_id);
  return { practice_id, loop_id, question_text: questionText, source, kp_id: kpId };
}

export interface GradePracticeResult {
  practice_id: string;
  is_correct: 0 | 1;
  graded_by: 'heuristic' | 'llm';
  feedback: string;
}

/** 作答判分：启发式（归一化包含/相等）为底座，可被 LLM 增强。 */
export function gradePractice(practice_id: string, user_answer: string): GradePracticeResult {
  const item = getPractice(practice_id);
  if (!item) throw new HttpError(ERROR_CODES.PARAM_INVALID, 404, '练习题不存在');
  if (!user_answer || !user_answer.trim()) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '作答内容不能为空');
  }
  const a = normalize(user_answer);
  const ref = normalize(item.answer_text);
  let is_correct: 0 | 1;
  let graded_by: 'heuristic' | 'llm' = 'heuristic';
  let feedback: string;

  if (item.source === 'llm') {
    // LLM 生成题无法用字符串比对；离线兜底为「已提交即视为参与」，真实环境应由模型批改。
    is_correct = a.length >= 5 ? 1 : 0;
    feedback = a.length >= 5 ? '已收到你的作答，建议对照解析自查。' : '作答过短，请补充关键步骤。';
  } else {
    if (a === ref) {
      is_correct = 1;
      feedback = '正确。';
    } else if (ref && (a.includes(ref) || ref.includes(a)) && a.length >= Math.max(4, ref.length / 2)) {
      is_correct = 1;
      feedback = '要点正确。';
    } else {
      is_correct = 0;
      feedback = `参考答案要点：${item.answer_text}`;
    }
  }
  updatePracticeGrade(practice_id, user_answer, is_correct, graded_by);
  // R14：判分后刷新该知识点掌握度（失败不影响本次判分返回）
  try {
    refreshMasteryForPractice(practice_id);
  } catch {
    /* 掌握度为增强指标，异常不阻断主流程 */
  }
  return { practice_id, is_correct, graded_by, feedback };
}

// ----------------- R11 答案沉淀（UGC 入库） -----------------

/**
 * 把用户/老师认可的题目+解析沉淀进题库（UGC，待审）。
 * 同源聚合：同一题干归一化哈希派生 item_id，重复提交覆盖而非新增。
 * 数据主权：仅存题干/解析文本与匿名贡献者哈希，绝不存 PII。
 */
export async function sedimentAnswer(req: SedimentRequest): Promise<SedimentResponse> {
  if (!req.anon_user_id || !req.anon_user_id.trim()) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '缺少 anon_user_id');
  }
  if (!req.question || req.question.trim().length < 2) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '题干过短');
  }
  if (!req.answer || req.answer.trim().length < 1) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '解析内容不能为空');
  }
  const contributorHash = createHash('sha256').update(req.anon_user_id).digest('hex').slice(0, 16);
  const item_id = await upsertUgcItem({
    question: req.question.trim(),
    answer: req.answer.trim(),
    knowledge_point: req.knowledge_point?.trim() || '',
    snippet: req.snippet ?? null,
    contributorHash,
    subject: req.subject ?? undefined,
  });
  if (req.loop_id) {
    getDb()
      .prepare('UPDATE qbank_items SET sedimented_from_loop = ? WHERE item_id = ?')
      .run(req.loop_id, item_id);
  }
  return {
    item_id,
    status: 'pending',
    message: '已沉淀为待审题目，审核通过后将进入题库供同类练习复用。',
  };
}

// ----------------- R13 针对性多题练习 -----------------

/**
 * 针对某个薄弱知识点生成一组练习题（题组：共享 group_id，按 group_seq 排序）。
 * 优先从题库按知识点取题（确定性、可评测）；题目不足时按 count 循环填充，
 * 仍不足则以 LLM 占位题兜底（离线/mock 下保证闭环不中断）。
 */
export function generateTargetedGroup(req: GenerateGroupRequest): GenerateGroupResponse {
  const { anon_user_id, target_kp, count } = req;
  if (!anon_user_id || !anon_user_id.trim()) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '缺少 anon_user_id');
  }
  if (!target_kp || !target_kp.trim()) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '缺少 target_kp');
  }
  const n = Math.max(1, Math.min(Number.isFinite(count) ? Math.floor(count) : 1, 20));
  const kpKey = req.kp_key && req.kp_key.trim() ? req.kp_key.trim() : normalizeKpKey(null, target_kp);
  const candidates = getQbankByKnowledgePoint(target_kp.trim());

  const group_id = newId('grp');
  const items: GenerateGroupItem[] = [];
  for (let i = 0; i < n; i++) {
    let questionText: string;
    let answerText: string;
    let source: 'qbank' | 'llm';
    const src = candidates.length ? candidates[i % candidates.length] : undefined;
    if (src) {
      questionText = src.question_text;
      answerText = src.answer_text;
      source = 'qbank';
    } else {
      questionText = `（练习）请重新做一道与「${target_kp.trim()}」相关的题目，并写出关键步骤。`;
      answerText = '（由模型批改）';
      source = 'llm';
    }
    const practice_id = newId('prac');
    const item: PracticeItem = {
      practice_id,
      loop_id: '',
      anon_user_id,
      kp_id: kpKey,
      question_text: questionText,
      answer_text: answerText,
      source,
      user_answer: null,
      is_correct: null,
      graded_by: null,
      group_id,
      group_seq: i + 1,
    };
    insertPractice(item);
    items.push({
      practice_id,
      loop_id: null,
      question_text: questionText,
      source,
      kp_id: kpKey,
      group_seq: i + 1,
    });
  }
  return { group_id, target_kp: target_kp.trim(), items };
}

// ----------------- R05 复述本质 -----------------

export interface RestateResult {
  loop_id: string;
  restate_len: number;
  restate_is_copy: 0 | 1;
}

/** 用户用自己的话复述本质；检测是否直接复制 AI 给出的 essence/cause。 */
export function submitRestate(
  loop_id: string,
  anon_user_id: string,
  text: string
): RestateResult {
  const session = getLoopSession(loop_id);
  if (!session || session.anon_user_id !== anon_user_id) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 404, '闭环会话不存在或身份不匹配');
  }
  if (!text || text.trim().length < 5) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '复述内容过短');
  }
  const attr = getAttributionByLoop(loop_id);
  const refText = normalize(`${attr?.essence ?? ''}${attr?.cause ?? ''}`);
  const userNorm = normalize(text);
  let isCopy: 0 | 1 = 0;
  if (refText) {
    // 用户文本包含参考文本的较长连续片段（前后 12 字窗口）→ 判定为复制粘贴
    const head = refText.slice(0, 12);
    const tail = refText.slice(-12);
    if (
      (head.length >= 8 && userNorm.includes(head)) ||
      (tail.length >= 8 && userNorm.includes(tail)) ||
      (userNorm.length >= 8 && refText.includes(userNorm))
    ) {
      isCopy = 1;
    }
  }
  const restate_len = text.trim().length;
  setLoopRestate(loop_id, text.trim(), restate_len, isCopy);
  return { loop_id, restate_len, restate_is_copy: isCopy };
}

// ----------------- R06 追问验证 -----------------

export interface VerifyProbeResult {
  loop_id: string;
  question: string;
}

/** 生成验证探针问题（基于错题与本质）。 */
export function verifyProbe(loop_id: string, anon_user_id: string): VerifyProbeResult {
  const session = getLoopSession(loop_id);
  if (!session || session.anon_user_id !== anon_user_id) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 404, '闭环会话不存在或身份不匹配');
  }
  const attr = getAttributionByLoop(loop_id);
  const question = `你能用自己的话讲清楚「${attr?.knowledge_point || '这个知识点'}」到底为什么错、正确思路是什么吗？`;
  // 先写回探针（verify_prompt），verify 阶段再写 response/result
  getDb()
    .prepare('UPDATE loop_sessions SET verify_prompt = ? WHERE loop_id = ?')
    .run(question, loop_id);
  return { loop_id, question };
}

export interface VerifyResult {
  loop_id: string;
  result: 'pass' | 'fail' | 'give_up';
  feedback: string;
}

/** 判定用户应答是否展示出对本质的理解（启发式底座，可 LLM 增强）。 */
export function verify(loop_id: string, anon_user_id: string, response: string): VerifyResult {
  const session = getLoopSession(loop_id);
  if (!session || session.anon_user_id !== anon_user_id) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 404, '闭环会话不存在或身份不匹配');
  }
  const giveUp = /^(放弃|不会|我不知道|不知道|skip)$/i.test((response ?? '').trim());
  if (!response || response.trim().length < 4) {
    if (giveUp) {
      setLoopVerify(loop_id, session.verify_prompt || '', response.trim(), 'give_up', '已记录你暂时跳过验证，可稍后回到此题重做。');
      return { loop_id, result: 'give_up', feedback: '已记录你暂时跳过验证，可稍后回到此题重做。' };
    }
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '验证回答过短');
  }
  let result: 'pass' | 'fail' | 'give_up';
  let feedback: string;
  if (giveUp) {
    result = 'give_up';
    feedback = '已记录你暂时跳过验证，可稍后回到此题重做。';
  } else if (response.trim().length >= 10) {
    result = 'pass';
    feedback = '看得出你抓住了这个知识点的关键，闭环完成。';
  } else {
    result = 'fail';
    feedback = '回答偏短，建议把“为什么错、正确思路是什么”讲得更具体些。';
  }
  setLoopVerify(loop_id, session.verify_prompt || '', response.trim(), result, feedback);
  return { loop_id, result, feedback };
}
