/**
 * practice_items + loop_sessions 复述/验证字段的数据访问层（v0.2）。
 * 复用 loopSessionModel.getLoopSession 与 qbank_items 知识点击题库。
 */
import { getDb } from '../db';
import { getLoopSession } from './loopSessionModel';

export interface PracticeItem {
  practice_id: string;
  loop_id: string;
  anon_user_id: string;
  kp_id: string | null;
  question_text: string;
  answer_text: string;
  source: 'qbank' | 'llm';
  user_answer: string | null;
  is_correct: 0 | 1 | null;
  graded_by: 'llm' | 'heuristic' | 'manual' | null;
  group_id: string | null;
  group_seq: number;
  created_at?: string;
}

export function insertPractice(item: PracticeItem): void {
  getDb()
    .prepare(
      `INSERT INTO practice_items (
        practice_id, loop_id, anon_user_id, kp_id, question_text, answer_text,
        source, user_answer, is_correct, graded_by, group_id, group_seq
      ) VALUES (
        @practice_id, @loop_id, @anon_user_id, @kp_id, @question_text, @answer_text,
        @source, @user_answer, @is_correct, @graded_by, @group_id, @group_seq
      )`
    )
    .run(item);
}

export function getPractice(practice_id: string): PracticeItem | undefined {
  return getDb()
    .prepare('SELECT * FROM practice_items WHERE practice_id = ?')
    .get(practice_id) as PracticeItem | undefined;
}

export function getPracticeByLoop(loop_id: string): PracticeItem[] {
  return getDb()
    .prepare('SELECT * FROM practice_items WHERE loop_id = ? ORDER BY group_seq, created_at')
    .all(loop_id) as PracticeItem[];
}

/** 作答判分写回。 */
export function updatePracticeGrade(
  practice_id: string,
  user_answer: string,
  is_correct: 0 | 1,
  graded_by: 'llm' | 'heuristic' | 'manual'
): void {
  getDb()
    .prepare(
      `UPDATE practice_items
       SET user_answer = ?, is_correct = ?, graded_by = ?
       WHERE practice_id = ?`
    )
    .run(user_answer, is_correct, graded_by, practice_id);
}

/** 标记本闭环已做过同类题（loop_sessions.has_practice=1）。 */
export function markLoopHasPractice(loop_id: string): void {
  getDb()
    .prepare('UPDATE loop_sessions SET has_practice = 1 WHERE loop_id = ?')
    .run(loop_id);
}

/** R05 复述：写回文本 + 长度 + 是否复制粘贴。 */
export function setLoopRestate(
  loop_id: string,
  restate_text: string,
  restate_len: number,
  restate_is_copy: 0 | 1
): void {
  getDb()
    .prepare(
      `UPDATE loop_sessions SET restate_text = ?, restate_len = ?, restate_is_copy = ? WHERE loop_id = ?`
    )
    .run(restate_text, restate_len, restate_is_copy, loop_id);
}

/** R06 追问验证：探针问题、用户应答、判定结果、反馈。 */
export function setLoopVerify(
  loop_id: string,
  verify_prompt: string,
  verify_response: string,
  verify_result: 'pass' | 'fail' | 'give_up',
  verify_feedback: string
): void {
  getDb()
    .prepare(
      `UPDATE loop_sessions
       SET verify_prompt = ?, verify_response = ?, verify_result = ?, verify_feedback = ?,
           verify_rounds = 1
       WHERE loop_id = ?`
    )
    .run(verify_prompt, verify_response, verify_result, verify_feedback, loop_id);
}

/** 按知识点文本取题库题（用于 R04 同类题）。返回未包含已用题干的候选。 */
export function getQbankByKnowledgePoint(
  knowledgePoint: string,
  excludeText?: string
): PracticeItemSource[] {
  const rows = getDb()
    .prepare('SELECT item_id, subject, question_text, answer_text, knowledge_point FROM qbank_items WHERE knowledge_point = ?')
    .all(knowledgePoint) as PracticeItemSource[];
  const filtered = excludeText
    ? rows.filter((r) => r.question_text !== excludeText)
    : rows;
  return filtered;
}

export interface PracticeItemSource {
  item_id: string;
  subject: string;
  question_text: string;
  answer_text: string;
  knowledge_point: string;
}

export { getLoopSession };
