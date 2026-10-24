/**
 * users 数据访问层（参数化 SQL，INF-01）
 */
import { getDb } from '../db';
import type { User } from '@aicorrection/shared';

export function createUser(user: User): void {
  getDb()
    .prepare(
      `INSERT INTO users (
        anon_user_id, segment, exp_id, exp_group, register_ts,
        first_pay_ts, last_active_ts, churn_status, churn_ts
      ) VALUES (
        @anon_user_id, @segment, @exp_id, @exp_group, @register_ts,
        @first_pay_ts, @last_active_ts, @churn_status, @churn_ts
      )`
    )
    .run(user);
}

export function getUser(anon_user_id: string): User | undefined {
  return getDb()
    .prepare('SELECT * FROM users WHERE anon_user_id = ?')
    .get(anon_user_id) as User | undefined;
}
