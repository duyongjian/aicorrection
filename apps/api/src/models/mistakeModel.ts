/**
 * mistakes 数据访问层（UPL-02）
 */
import { getDb } from '../db';
import type { Mistake } from '@aicorrection/shared';

export function createMistake(mistake: Mistake): void {
  getDb()
    .prepare(
      `INSERT INTO mistakes (
        mistake_id, anon_user_id, loop_id, subject, src_type, ocr_status, mistake_ref, created_at
      ) VALUES (
        @mistake_id, @anon_user_id, @loop_id, @subject, @src_type, @ocr_status, @mistake_ref, @created_at
      )`
    )
    .run(mistake);
}

export function getMistake(mistake_id: string): Mistake | undefined {
  return getDb()
    .prepare('SELECT * FROM mistakes WHERE mistake_id = ?')
    .get(mistake_id) as Mistake | undefined;
}
