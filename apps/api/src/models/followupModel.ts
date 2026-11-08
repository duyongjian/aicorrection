/**
 * followups 数据访问层（021）：持久化追问对话，支持按 loop 回看。
 */
import { getDb } from '../db';
import { generateFollowupId } from '../utils/id';

export interface FollowupRow {
  followup_id: string;
  loop_id: string;
  anon_user_id: string;
  seq: number;
  role: 'user' | 'ai';
  content: string;
  created_at: string;
}

/** 写入一条追问（user 提问 或 ai 回复）。 */
export function createFollowup(input: {
  loop_id: string;
  anon_user_id: string;
  role: 'user' | 'ai';
  content: string;
}): void {
  const seq =
    (getDb()
      .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM followups WHERE loop_id = ?')
      .get(input.loop_id) as { m: number }).m + 1;
  getDb()
    .prepare(
      `INSERT INTO followups (followup_id, loop_id, anon_user_id, seq, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(generateFollowupId(), input.loop_id, input.anon_user_id, seq, input.role, input.content);
}

/** 按 loop 拉取追问对话（含 anon_user_id 校验，防越权）。 */
export function listFollowups(loop_id: string, anon_user_id: string): FollowupRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM followups WHERE loop_id = ? AND anon_user_id = ? ORDER BY seq ASC`
    )
    .all(loop_id, anon_user_id) as FollowupRow[];
}
