/**
 * 真实账号数据访问层（v0.2 地基）
 * 仅参数化 SQL；服务端不存任何明文密码/验证码/魔法令牌（只存哈希）。
 */
import { getDb } from '../db';
import type { AuthProvider } from '@aicorrection/shared';

export interface AccountRow {
  id: number;
  anon_user_id: string;
  provider: AuthProvider;
  identifier: string;
  secret_hash: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface AuthSessionRow {
  token_hash: string;
  anon_user_id: string;
  provider: string;
  last_seen_at: string;
  created_at: string;
}

export interface NewCredential {
  anon_user_id: string;
  provider: AuthProvider;
  identifier: string;
  secret_hash?: string | null;
  verified_at?: string | null;
}

export function createCredential(c: NewCredential): void {
  getDb()
    .prepare(
      `INSERT INTO accounts (anon_user_id, provider, identifier, secret_hash, verified_at)
       VALUES (@anon_user_id, @provider, @identifier, @secret_hash, @verified_at)`
    )
    .run({
      anon_user_id: c.anon_user_id,
      provider: c.provider,
      identifier: c.identifier,
      secret_hash: c.secret_hash ?? null,
      verified_at: c.verified_at ?? null,
    });
}

export function findCredential(
  provider: AuthProvider,
  identifier: string
): AccountRow | undefined {
  return getDb()
    .prepare('SELECT * FROM accounts WHERE provider = ? AND identifier = ?')
    .get(provider, identifier) as AccountRow | undefined;
}

export function findCredentialsByUser(anon_user_id: string): AccountRow[] {
  return getDb()
    .prepare('SELECT * FROM accounts WHERE anon_user_id = ? ORDER BY created_at')
    .all(anon_user_id) as AccountRow[];
}

export function insertAuthSession(row: {
  token_hash: string;
  anon_user_id: string;
  provider: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO auth_sessions (token_hash, anon_user_id, provider)
       VALUES (@token_hash, @anon_user_id, @provider)`
    )
    .run(row);
}

export function getAuthSession(tokenHash: string): AuthSessionRow | undefined {
  return getDb()
    .prepare('SELECT * FROM auth_sessions WHERE token_hash = ?')
    .get(tokenHash) as AuthSessionRow | undefined;
}

export function touchAuthSession(tokenHash: string, at: string): void {
  getDb()
    .prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?')
    .run(at, tokenHash);
}

export function deleteAuthSession(tokenHash: string): void {
  getDb().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
}

// ----------------- 短信验证码（每手机号只留最新一条） -----------------

export function upsertSmsCode(phone: string, codeHash: string): void {
  getDb()
    .prepare(
      `INSERT INTO sms_codes (phone, code_hash, created_at, attempts, consumed)
       VALUES (@phone, @code_hash, datetime('now'), 0, 0)
       ON CONFLICT(phone) DO UPDATE SET
         code_hash = excluded.code_hash,
         created_at = excluded.created_at,
         attempts = 0,
         consumed = 0`
    )
    .run({ phone, code_hash: codeHash });
}

export function getSmsCode(phone: string): {
  phone: string;
  code_hash: string;
  created_at: string;
  attempts: number;
  consumed: number;
} | undefined {
  return getDb()
    .prepare('SELECT * FROM sms_codes WHERE phone = ?')
    .get(phone) as
    | { phone: string; code_hash: string; created_at: string; attempts: number; consumed: number }
    | undefined;
}

export function incrementSmsAttempts(phone: string): void {
  getDb()
    .prepare('UPDATE sms_codes SET attempts = attempts + 1 WHERE phone = ?')
    .run(phone);
}

export function consumeSmsCode(phone: string): void {
  getDb().prepare('UPDATE sms_codes SET consumed = 1 WHERE phone = ?').run(phone);
}

// ----------------- 魔法链接令牌（每邮箱只留最新一条） -----------------

export function upsertMagicToken(email: string, tokenHash: string): void {
  getDb()
    .prepare(
      `INSERT INTO magic_tokens (email, token_hash, created_at, consumed)
       VALUES (@email, @token_hash, datetime('now'), 0)
       ON CONFLICT(email) DO UPDATE SET
         token_hash = excluded.token_hash,
         created_at = excluded.created_at,
         consumed = 0`
    )
    .run({ email, token_hash: tokenHash });
}

export function getMagicToken(email: string): {
  email: string;
  token_hash: string;
  created_at: string;
  consumed: number;
} | undefined {
  return getDb()
    .prepare('SELECT * FROM magic_tokens WHERE email = ?')
    .get(email) as
    | { email: string; token_hash: string; created_at: string; consumed: number }
    | undefined;
}

export function consumeMagicToken(email: string): void {
  getDb().prepare('UPDATE magic_tokens SET consumed = 1 WHERE email = ?').run(email);
}
