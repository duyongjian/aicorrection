/**
 * 自定义知识点数据访问层（P2：R17 自定义知识点）。
 * 系统受控词表（kp_*）之外的个人化标签，可挂到某个父知识点下形成层级；
 * 自定义 kp_id 以 'ckp_' 前缀避免与系统词表冲突（迁移 019 已加 CHECK）。
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '../db';
import type { CustomKpItem } from '@aicorrection/shared';

export function insertCustomKp(row: {
  anon_user_id: string;
  kp_text: string;
  parent_kp_key: string | null;
}): CustomKpItem {
  const kp_id = `ckp_${randomBytes(8).toString('hex')}`;
  getDb()
    .prepare(
      `INSERT INTO custom_knowledge_points (kp_id, anon_user_id, kp_text, parent_kp_key)
       VALUES (?, ?, ?, ?)`
    )
    .run(kp_id, row.anon_user_id, row.kp_text, row.parent_kp_key);
  return {
    kp_id,
    anon_user_id: row.anon_user_id,
    kp_text: row.kp_text,
    parent_kp_key: row.parent_kp_key,
    created_at: new Date().toISOString(),
  };
}

export function getCustomKps(anon_user_id: string): CustomKpItem[] {
  return getDb()
    .prepare('SELECT * FROM custom_knowledge_points WHERE anon_user_id = ? ORDER BY created_at DESC')
    .all(anon_user_id) as CustomKpItem[];
}

export function getCustomKp(kp_id: string): CustomKpItem | undefined {
  return getDb()
    .prepare('SELECT * FROM custom_knowledge_points WHERE kp_id = ?')
    .get(kp_id) as CustomKpItem | undefined;
}
