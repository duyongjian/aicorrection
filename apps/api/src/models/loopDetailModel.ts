/**
 * 闭环回看聚合（FLW-02 增强）：按 loop 汇总「归因 + 追问 + 练习 + 复盘（复述/验证）」，
 * 供历史详情页完整可回顾。所有查询均按 anon_user_id 二次校验，防越权。
 */
import { getDb } from '../db';
import { env } from '../config/env';
import { listFollowups, type FollowupRow } from './followupModel';

export interface PracticeItemRow {
  practice_id: string;
  question_text: string;
  answer_text: string | null;
  user_answer: string | null;
  is_correct: number | null;
  created_at: string;
}

export interface LoopDetail {
  loop_id: string;
  image_url: string | null;
  attribution: {
    attribution_id: string;
    cause: string | null;
    knowledge_point: string | null;
    essence: string | null;
    correct_answer: string | null;
    derivation: string | null;
    pitfalls: string | null;
    rate_action: string | null;
    created_at: string;
  } | null;
  followups: FollowupRow[];
  practice: PracticeItemRow[];
  closure: {
    followup_rounds: number;
    has_practice: number | null;
    restate_len: number | null;
    restate_is_copy: number | null;
    restate_text: string | null;
    verify_result: string | null;
    verify_prompt: string | null;
    verify_response: string | null;
    verify_feedback: string | null;
  };
}

export function getLoopDetail(
  loop_id: string,
  anon_user_id: string
): LoopDetail | null {
  const session = getDb()
    .prepare('SELECT * FROM loop_sessions WHERE loop_id = ?')
    .get(loop_id) as
    | {
        anon_user_id: string;
        followup_rounds: number;
        has_practice: number | null;
        restate_len: number | null;
        restate_is_copy: number | null;
        restate_text: string | null;
        verify_result: string | null;
        verify_prompt: string | null;
        verify_response: string | null;
        verify_feedback: string | null;
      }
    | undefined;
  if (!session || session.anon_user_id !== anon_user_id) return null;

  const attribution = getDb()
    .prepare(
      `SELECT attribution_id, cause, knowledge_point, essence, correct_answer,
              derivation, pitfalls, rate_action, created_at
       FROM attributions WHERE loop_id = ? AND anon_user_id = ? LIMIT 1`
    )
    .get(loop_id, anon_user_id) as LoopDetail['attribution'];

  const m = getDb()
    .prepare('SELECT mistake_ref, src_type FROM mistakes WHERE loop_id = ?')
    .get(loop_id) as { mistake_ref: string | null; src_type: string } | undefined;
  const image_url =
    m && m.src_type === 'photo' && m.mistake_ref && !m.mistake_ref.startsWith('hash:')
      ? `${env.API_BASE_PATH}/uploads/${m.mistake_ref}`
      : null;

  const practice = getDb()
    .prepare(
      `SELECT practice_id, question_text, answer_text, user_answer, is_correct, created_at
       FROM practice_items WHERE loop_id = ? AND anon_user_id = ? ORDER BY created_at ASC`
    )
    .all(loop_id, anon_user_id) as PracticeItemRow[];

  const followups = listFollowups(loop_id, anon_user_id);

  return {
    loop_id,
    image_url,
    attribution: attribution ?? null,
    followups,
    practice,
    closure: {
      followup_rounds: session.followup_rounds,
      has_practice: session.has_practice,
      restate_len: session.restate_len,
      restate_is_copy: session.restate_is_copy,
      restate_text: session.restate_text,
      verify_result: session.verify_result,
      verify_prompt: session.verify_prompt,
      verify_response: session.verify_response,
      verify_feedback: session.verify_feedback,
    },
  };
}
