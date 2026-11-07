/**
 * 卡密 / 凭证会话数据访问层（线下分发 MVP）
 * 仅参数化 SQL；服务端不存任何明文卡密或明文 token。
 */
import { getDb } from '../db';
import type { LicenseStatus } from '@aicorrection/shared';

export interface LicenseKeyRow {
  code_hash: string;
  code_hint: string;
  batch_id: string;
  note: string | null;
  status: LicenseStatus;
  expires_at: string | null;
  anon_user_id: string | null;
  created_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
}

export interface LicenseSessionRow {
  token_hash: string;
  anon_user_id: string;
  code_hash: string;
  created_at: string;
  last_seen_at: string;
}

export interface NewLicenseKey {
  code_hash: string;
  code_hint: string;
  batch_id: string;
  note: string | null;
  expires_at: string | null;
}

/**
 * 插入一张卡密；hash 极罕见冲突时返回 false，由调用方重新生成。
 * 用 INSERT OR IGNORE 避免把「碰撞」误报成数据库错误。
 */
export function tryInsertLicenseKey(row: NewLicenseKey): boolean {
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO license_keys (code_hash, code_hint, batch_id, note, status, expires_at)
       VALUES (@code_hash, @code_hint, @batch_id, @note, 'unused', @expires_at)`
    )
    .run(row);
  return info.changes === 1;
}

export function getLicenseKey(codeHash: string): LicenseKeyRow | undefined {
  return getDb()
    .prepare('SELECT * FROM license_keys WHERE code_hash = ?')
    .get(codeHash) as LicenseKeyRow | undefined;
}

/**
 * 原子兑换：仅当仍为 unused 时改为 redeemed。
 * 用条件 UPDATE 而非「先 SELECT 再 UPDATE」，避免两个请求同时兑换同一张卡密。
 */
export function markLicenseRedeemed(
  codeHash: string,
  anonUserId: string,
  at: string
): boolean {
  const info = getDb()
    .prepare(
      `UPDATE license_keys
          SET status = 'redeemed', anon_user_id = ?, redeemed_at = ?
        WHERE code_hash = ? AND status = 'unused'`
    )
    .run(anonUserId, at, codeHash);
  return info.changes === 1;
}

export function markLicenseRevoked(codeHash: string, at: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE license_keys
          SET status = 'revoked', revoked_at = ?
        WHERE code_hash = ? AND status <> 'revoked'`
    )
    .run(at, codeHash);
  return info.changes === 1;
}

export function listLicenseKeys(batchId?: string): LicenseKeyRow[] {
  if (batchId) {
    return getDb()
      .prepare('SELECT * FROM license_keys WHERE batch_id = ? ORDER BY created_at, code_hint')
      .all(batchId) as LicenseKeyRow[];
  }
  return getDb()
    .prepare('SELECT * FROM license_keys ORDER BY created_at DESC, code_hint')
    .all() as LicenseKeyRow[];
}

export function insertLicenseSession(row: {
  token_hash: string;
  anon_user_id: string;
  code_hash: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO license_sessions (token_hash, anon_user_id, code_hash)
       VALUES (@token_hash, @anon_user_id, @code_hash)`
    )
    .run(row);
}

export function getLicenseSession(tokenHash: string): LicenseSessionRow | undefined {
  return getDb()
    .prepare('SELECT * FROM license_sessions WHERE token_hash = ?')
    .get(tokenHash) as LicenseSessionRow | undefined;
}

export function touchLicenseSession(tokenHash: string, at: string): void {
  getDb()
    .prepare('UPDATE license_sessions SET last_seen_at = ? WHERE token_hash = ?')
    .run(at, tokenHash);
}
