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

export function deleteUser(anon_user_id: string): void {
  getDb().prepare('DELETE FROM users WHERE anon_user_id = ?').run(anon_user_id);
}

/**
 * 身份合并：把 fromId 名下的用户数据迁移到 toId，并删除 fromId 的 users 行。
 * 仅迁移以 anon_user_id 为普通列（非复合主键）的「错题/归因/学习」记录表，避免
 * (anon_user_id, kp_key) 复合主键表（review_schedule / mastery_state）在合并时产生
 * 唯一冲突——这两类派生数据可由归因/练习历史重算，无需迁移。
 * 商业表（license_sessions / subscriptions / payments）与身份表（accounts /
 * auth_sessions / credentials）不在此迁移：匿名身份本无这些记录，合并后由 toId 接管。
 */
const MERGE_TABLES = [
  'loop_sessions',
  'mistakes',
  'attributions',
  'practice_items',
  'custom_knowledge_points',
  'analytics_events',
] as const;

export function mergeUserInto(fromId: string, toId: string): void {
  if (!fromId || !toId || fromId === toId) return;
  if (!getUser(fromId) || !getUser(toId)) return;
  const db = getDb();
  db.transaction(() => {
    for (const t of MERGE_TABLES) {
      db.prepare(`UPDATE ${t} SET anon_user_id = ? WHERE anon_user_id = ?`).run(toId, fromId);
    }
    deleteUser(fromId);
  })();
}

/**
 * 彻底注销：删除该 anon_user_id 名下的全部数据（错题/归因/练习/自定义知识点/复习/
 * 掌握度/商业表/凭证/会话/用户行）。
 *
 * 顺序约束：foreign_keys=ON，且 SQLite 不允许在事务内切换 PRAGMA foreign_keys，
 * 故必须按外键依赖从子表到父表手动删除，最后删 users 行
 * （accounts / auth_sessions 已设 ON DELETE CASCADE，显式先删亦安全；
 *  license_sessions 的 anon_user_id 无 FK 指向 users，必须显式删除）。
 */
const PURGE_TABLES = [
  'attributions', // 引用 loop_sessions.loop_id / mistakes.mistake_id，须最先删
  'mistakes',
  'loop_sessions',
  'practice_items',
  'custom_knowledge_points',
  'review_sessions',
  'review_schedule',
  'mastery_state',
  'analytics_events',
  'subscriptions',
  'payments',
  'accounts', // ON DELETE CASCADE，显式删安全
  'auth_sessions', // ON DELETE CASCADE，显式删安全
  'license_sessions', // 无 FK 指向 users，必须显式删
] as const;

export function purgeUserData(anon_user_id: string): void {
  if (!anon_user_id || !getUser(anon_user_id)) return;
  const db = getDb();
  db.transaction(() => {
    for (const t of PURGE_TABLES) {
      db.prepare(`DELETE FROM ${t} WHERE anon_user_id = ?`).run(anon_user_id);
    }
    deleteUser(anon_user_id);
  })();
}

/**
 * 导出该身份的全部业务数据（数据可携性 / 注销前留底）。
 *
 * 安全取舍：
 *  - 只导「业务数据」，不导凭证机密——accounts（登录凭证，含密码哈希）、
 *    auth_sessions / license_sessions / magic_tokens 这类会话/令牌表整体不导（对备份无意义且属敏感）。
 *  - 兼容陈旧副本库（缺表）：表不存在时跳过并记 0，不报错。
 *  - 返回结构固定为 { meta, data }，meta 含导出时间、身份与每张表记录数，便于前端展示与核对。
 */
const EXPORT_TABLES: Array<{ table: string; columns?: string }> = [
  { table: 'users' },
  { table: 'loop_sessions' },
  { table: 'mistakes' },
  { table: 'attributions' },
  { table: 'practice_items' },
  { table: 'custom_knowledge_points' },
  { table: 'review_sessions' },
  { table: 'review_schedule' },
  { table: 'mastery_state' },
  { table: 'analytics_events' },
  { table: 'subscriptions' },
  { table: 'payments' },
];

export function exportUserData(
  anon_user_id: string
): { meta: { exported_at: string; anon_user_id: string; counts: Record<string, number> }; data: Record<string, unknown[]> } {
  const meta = { exported_at: new Date().toISOString(), anon_user_id, counts: {} as Record<string, number> };
  const data: Record<string, unknown[]> = {};
  if (!anon_user_id || !getUser(anon_user_id)) {
    return { meta, data };
  }
  const db = getDb();
  for (const { table, columns } of EXPORT_TABLES) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!exists) {
      data[table] = [];
      meta.counts[table] = 0;
      continue;
    }
    const rows = db
      .prepare(`SELECT ${columns ?? '*'} FROM ${table} WHERE anon_user_id = ?`)
      .all(anon_user_id) as unknown[];
    data[table] = rows;
    meta.counts[table] = rows.length;
  }
  return { meta, data };
}

