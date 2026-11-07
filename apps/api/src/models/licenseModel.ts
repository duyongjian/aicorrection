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
  tier: string;
  entitlements_json: string | null;
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
  tier: string;
  created_at: string;
  last_seen_at: string;
}

export interface NewLicenseKey {
  code_hash: string;
  code_hint: string;
  batch_id: string;
  note: string | null;
  tier: string;
  entitlements_json: string | null;
  expires_at: string | null;
}

export interface SubscriptionRow {
  subscription_id: string;
  anon_user_id: string;
  provider: string;
  provider_sub_id: string | null;
  tier: string;
  status: string;
  current_period_start: string;
  current_period_end: string;
  created_at: string;
  cancelled_at: string | null;
}

export interface PaymentRow {
  payment_id: string;
  anon_user_id: string;
  provider: string;
  amount_cents: number;
  currency: string;
  tier: string;
  status: string;
  created_at: string;
  paid_at: string | null;
}

/**
 * 插入一张卡密；hash 极罕见冲突时返回 false，由调用方重新生成。
 * 用 INSERT OR IGNORE 避免把「碰撞」误报成数据库错误。
 */
export function tryInsertLicenseKey(row: NewLicenseKey): boolean {
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO license_keys (code_hash, code_hint, batch_id, note, status, tier, entitlements_json, expires_at)
       VALUES (@code_hash, @code_hint, @batch_id, @note, 'unused', @tier, @entitlements_json, @expires_at)`
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
  tier: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO license_sessions (token_hash, anon_user_id, code_hash, tier)
       VALUES (@token_hash, @anon_user_id, @code_hash, @tier)`
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

/** 按匿名账号查其已兑换的卡密（续费/查档位用）。无则返回 undefined。 */
export function getLicenseKeyByAnon(anonUserId: string): LicenseKeyRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM license_keys WHERE anon_user_id = ? AND status = 'redeemed' ORDER BY redeemed_at DESC LIMIT 1`
    )
    .get(anonUserId) as LicenseKeyRow | undefined;
}

/** 延长卡密有效期（续费核心写操作）。newExpiresAt 为绝对 ISO 时间。 */
export function extendLicenseExpiry(codeHash: string, newExpiresAt: string | null): boolean {
  const info = getDb()
    .prepare('UPDATE license_keys SET expires_at = ? WHERE code_hash = ?')
    .run(newExpiresAt, codeHash);
  return info.changes === 1;
}

/** 更新卡密档位（续费升档用）。 */
export function setLicenseTier(codeHash: string, tier: string): boolean {
  const info = getDb()
    .prepare('UPDATE license_keys SET tier = ? WHERE code_hash = ?')
    .run(tier, codeHash);
  return info.changes === 1;
}

/** 同步已发行会话的档位（续费升档后，verify 不会读到期旧档位）。 */
export function setLicenseSessionTierByCode(codeHash: string, tier: string): void {
  getDb()
    .prepare('UPDATE license_sessions SET tier = ? WHERE code_hash = ?')
    .run(tier, codeHash);
}

// ===================== 订阅 / 支付台账 =====================

export function insertSubscription(row: {
  subscription_id: string;
  anon_user_id: string;
  provider: string;
  provider_sub_id: string | null;
  tier: string;
  current_period_start: string;
  current_period_end: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO subscriptions
        (subscription_id, anon_user_id, provider, provider_sub_id, tier, status, current_period_start, current_period_end)
       VALUES (@subscription_id, @anon_user_id, @provider, @provider_sub_id, @tier, 'active', @current_period_start, @current_period_end)`
    )
    .run(row);
}

export function getActiveSubscription(anonUserId: string): SubscriptionRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM subscriptions WHERE anon_user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`
    )
    .get(anonUserId) as SubscriptionRow | undefined;
}

export function cancelSubscription(subscriptionId: string, at: string): boolean {
  const info = getDb()
    .prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = ? WHERE subscription_id = ?")
    .run(at, subscriptionId);
  return info.changes === 1;
}

export function insertPayment(row: {
  payment_id: string;
  anon_user_id: string;
  provider: string;
  amount_cents: number;
  currency: string;
  tier: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO payments (payment_id, anon_user_id, provider, amount_cents, currency, tier)
       VALUES (@payment_id, @anon_user_id, @provider, @amount_cents, @currency, @tier)`
    )
    .run(row);
}

export function markPaymentPaid(paymentId: string, at: string): boolean {
  const info = getDb()
    .prepare("UPDATE payments SET status = 'paid', paid_at = ? WHERE payment_id = ?")
    .run(at, paymentId);
  return info.changes === 1;
}
