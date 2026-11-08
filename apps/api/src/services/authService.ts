/**
 * 真实账号服务（v0.2 地基）
 *
 * 设计取舍：anon_user_id 是系统内唯一身份主键；本服务只负责把各类凭证
 * （邮箱密码 / 短信 / 微信 / 魔法链接）解析回同一个 anon_user_id，并签发 auth token。
 * 老匿名用户、卡密用户的数据与身份流完全不变——新账号体系纯增量接入，
 * 且可通过 `link_anon_user_id` 把新凭证绑定到已有身份（平滑迁移）。
 *
 * 数据主权：服务端只存 密码 scrypt 哈希 / 验证码哈希 / token 哈希，明文只在本进程内
 * 出现一次（注册/登录响应、dev 模式回显），绝不写库、不写日志明文。
 *
 * provider 可插拔：SMS_PROVIDER / EMAIL_PROVIDER / 微信凭证 未配置时进入 dev 模式，
 * 验证码/魔法链接直接回显给调用方，便于离线自测；配置后走真实发送（接入点预留）。
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../middleware/errorHandler';
import { createAccount, getAccount } from './accountService';
import { getUser, mergeUserInto } from '../models/userModel';
import { getDb } from '../db';
import {
  createCredential,
  findCredential,
  findCredentialsByUser,
  insertAuthSession,
  getAuthSession,
  touchAuthSession,
  deleteAuthSession,
  upsertSmsCode,
  getSmsCode,
  incrementSmsAttempts,
  consumeSmsCode,
  upsertMagicToken,
  getMagicToken,
  consumeMagicToken,
} from '../models/accountModel';
import { ERROR_CODES } from '@aicorrection/shared';
import type {
  AuthTokenResponse,
  AuthRegisterRequest,
  AuthLoginRequest,
  AuthSmsSendRequest,
  AuthSmsSendResponse,
  AuthSmsVerifyRequest,
  AuthWechatRequest,
  AuthMagicSendRequest,
  AuthMagicSendResponse,
  AuthMagicVerifyRequest,
  AuthStatusResponse,
  AuthMeResponse,
  AuthProvider,
  Segment,
  LicenseTier,
} from '@aicorrection/shared';

// ----------------- 配置（env 直读，避免改动 env.ts 大块） -----------------

const AUTH_TOKEN_TTL_MS = Number(process.env.AUTH_TOKEN_TTL_MS ?? 30 * 24 * 60 * 60 * 1000); // 30 天
const SMS_CODE_TTL_MS = Number(process.env.SMS_CODE_TTL_MS ?? 5 * 60 * 1000); // 5 分钟
const MAGIC_TOKEN_TTL_MS = Number(process.env.MAGIC_TOKEN_TTL_MS ?? 15 * 60 * 1000); // 15 分钟
const SMS_MAX_ATTEMPTS = Number(process.env.SMS_MAX_ATTEMPTS ?? 5);

// ----------------- 哈希工具 -----------------

const HASH_PREFIX = { token: 'aicorrection:auth:', secret: 'aicorrection:secret:', sms: 'aicorrection:sms:', magic: 'aicorrection:magic:' } as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function hashToken(token: string): string {
  return sha256(HASH_PREFIX.token + token);
}
function hashSms(code: string): string {
  return sha256(HASH_PREFIX.sms + code);
}
function hashMagic(token: string): string {
  return sha256(HASH_PREFIX.magic + token);
}

/** 密码哈希：随机盐 + scrypt(64 字节)，存储 `salt:hash`（hex）。 */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const computed = scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(computed, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function normalizeEmail(email: string): string {
  return String(email ?? '').trim().toLowerCase();
}
function normalizePhone(phone: string): string {
  return String(phone ?? '').trim();
}

// ----------------- provider 接入点（未配置 → dev 模式） -----------------

/**
 * 发送短信验证码。未配置 SMS_PROVIDER 时为 dev 模式（不真发，靠响应回显 dev_code）；
 * 配置后在此按 provider 名调用真实发送实现。当前预留接入点。
 */
async function dispatchSms(_phone: string, _code: string): Promise<void> {
  const provider = process.env.SMS_PROVIDER;
  if (!provider) return; // dev 模式
  // TODO(接入): 按 provider 名（aliyun / tencent / ...）调用真实短信网关。
  throw new HttpError(
    ERROR_CODES.AUTH_PROVIDER_NOT_CONFIGURED,
    501,
    `SMS_PROVIDER=${provider} 尚未接入发送逻辑`
  );
}

/**
 * 发送魔法链接邮件。未配置 EMAIL_PROVIDER 时为 dev 模式（不真发，靠响应回显 dev_token）。
 */
async function dispatchMagicEmail(_email: string, _link: string): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER;
  if (!provider) return; // dev 模式
  // TODO(接入): 按 provider 名（smtp / sendgrid / ...）调用真实邮件发送。
  throw new HttpError(
    ERROR_CODES.AUTH_PROVIDER_NOT_CONFIGURED,
    501,
    `EMAIL_PROVIDER=${provider} 尚未接入发送逻辑`
  );
}

/**
 * 微信 code 换 openid。未配置 WECHAT_APP_ID/WECHAT_APP_SECRET 时直接报错，
 * 要求显式接入，不臆造。
 */
async function exchangeWechatCode(code: string): Promise<string> {
  const appId = process.env.WECHAT_APP_ID;
  const appSecret = process.env.WECHAT_APP_SECRET;
  if (!appId || !appSecret) {
    throw new HttpError(
      ERROR_CODES.AUTH_PROVIDER_NOT_CONFIGURED,
      400,
      '微信登录未配置（缺少 WECHAT_APP_ID / WECHAT_APP_SECRET），暂不可用'
    );
  }
  // TODO(接入): 调用 https://api.weixin.qq.com/sns/oauth2/access_token?appid=...&secret=...&code=...
  // 解析 openid。当前未接入真实网关。
  throw new HttpError(
    ERROR_CODES.AUTH_PROVIDER_NOT_CONFIGURED,
    501,
    '微信 code 换取尚未接入真实网关'
  );
}

// ----------------- 身份解析（链接 / 新建） -----------------

/**
 * 把 (provider, identifier) 解析为一个 anon_user_id：
 *  - 若该凭证已存在 → 复用其 anon_user_id（登录）；
 *  - 否则：若提供了有效 link_anon_user_id → 把新凭证挂到该身份（迁移/补绑）；
 *          否则新建一个匿名账号并挂上凭证（注册）。
 * 全程在一个事务内，避免「建了账号却没挂上凭证」的半成品。
 */
function resolveOrCreateUser(opts: {
  provider: AuthProvider;
  identifier: string;
  segment: Segment;
  secretHash?: string | null;
  linkAnonUserId?: string;
}): { anon_user_id: string; isNew: boolean; segment: Segment } {
  const existing = findCredential(opts.provider, opts.identifier);
  if (existing) {
    const acc = getAccount(existing.anon_user_id);
    return { anon_user_id: existing.anon_user_id, isNew: false, segment: (acc?.segment ?? opts.segment) as Segment };
  }

  const db = getDb();
  const result = db.transaction((): { anon_user_id: string; isNew: boolean; segment: Segment } => {
    let anonUserId = opts.linkAnonUserId?.trim() || '';
    let isNew = false;
    if (anonUserId && getUser(anonUserId)) {
      // 绑定到已有身份（卡密/匿名用户补绑真实账号）
    } else {
      const acc = createAccount({ segment: opts.segment });
      anonUserId = acc.anon_user_id;
      isNew = true;
    }
    createCredential({
      anon_user_id: anonUserId,
      provider: opts.provider,
      identifier: opts.identifier,
      secret_hash: opts.secretHash ?? null,
      verified_at: new Date().toISOString(),
    });
    return { anon_user_id: anonUserId, isNew, segment: opts.segment };
  })();
  return result;
}

function issueSession(anon_user_id: string, provider: AuthProvider): string {
  const token = randomBytes(32).toString('hex');
  insertAuthSession({ token_hash: hashToken(token), anon_user_id, provider });
  return token;
}

// ----------------- 邮箱密码：注册 / 登录 -----------------

export function registerWithPassword(req: AuthRegisterRequest): AuthTokenResponse {
  const email = normalizeEmail(req.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '邮箱格式不正确');
  }
  if (typeof req.password !== 'string' || req.password.length < 8) {
    throw new HttpError(ERROR_CODES.AUTH_PASSWORD_WEAK, 400, '密码至少 8 位');
  }
  if (findCredential('password', email)) {
    throw new HttpError(ERROR_CODES.AUTH_EMAIL_TAKEN, 409, '该邮箱已注册，请直接登录');
  }
  const { anon_user_id } = resolveOrCreateUser({
    provider: 'password',
    identifier: email,
    segment: req.segment,
    secretHash: hashPassword(req.password),
    linkAnonUserId: req.link_anon_user_id,
  });
  const token = issueSession(anon_user_id, 'password');
  return {
    auth_token: token,
    anon_user_id,
    segment: req.segment,
    provider: 'password',
    bound_at: new Date().toISOString(),
  };
}

export function loginWithPassword(req: AuthLoginRequest): AuthTokenResponse {
  const email = normalizeEmail(req.email);
  const cred = findCredential('password', email);
  if (!cred || !cred.secret_hash || !verifyPassword(req.password, cred.secret_hash)) {
    throw new HttpError(ERROR_CODES.AUTH_INVALID, 401, '邮箱或密码错误');
  }
  const acc = getAccount(cred.anon_user_id);
  // 登录时合并浏览器本地匿名身份（若传入且与账号身份不同），使登录前的错题/归因等记录归属账号。
  if (req.link_anon_user_id) {
    mergeUserInto(req.link_anon_user_id, cred.anon_user_id);
  }
  const token = issueSession(cred.anon_user_id, 'password');
  return {
    auth_token: token,
    anon_user_id: cred.anon_user_id,
    segment: (acc?.segment ?? 'gaozhong') as Segment,
    provider: 'password',
    bound_at: new Date().toISOString(),
  };
}

// ----------------- 短信验证码：发送 / 校验登录 -----------------

export async function sendSmsCode(req: AuthSmsSendRequest): Promise<AuthSmsSendResponse> {
  const phone = normalizePhone(req.phone);
  if (!/^\+?[0-9]{6,15}$/.test(phone)) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '手机号格式不正确');
  }
  const code = String(randomInt(10 ** (6 - 1), 10 ** 6 - 1)).padStart(6, '0');
  upsertSmsCode(phone, hashSms(code));
  await dispatchSms(phone, code); // dev 模式不发送
  // dev 模式回显，便于离线自测；生产（已配 SMS_PROVIDER）不会走到这里。
  if (!process.env.SMS_PROVIDER) {
    return { ok: true, dev_code: code, message: '验证码已生成（dev 模式，未真实发送）' };
  }
  return { ok: true, message: '验证码已发送' };
}

export function verifySmsLogin(req: AuthSmsVerifyRequest): AuthTokenResponse {
  const phone = normalizePhone(req.phone);
  const row = getSmsCode(phone);
  if (!row || row.consumed) {
    throw new HttpError(ERROR_CODES.AUTH_CODE_INVALID, 400, '验证码无效，请重新获取');
  }
  // TTL 校验（SQLite datetime('now') 为 UTC 无时区标记，统一按 UTC 解析）
  const raw = row.created_at;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  if (Date.now() - new Date(normalized).getTime() > SMS_CODE_TTL_MS) {
    throw new HttpError(ERROR_CODES.AUTH_CODE_EXPIRED, 400, '验证码已过期，请重新获取');
  }
  if (row.attempts >= SMS_MAX_ATTEMPTS) {
    throw new HttpError(ERROR_CODES.AUTH_TOO_MANY_ATTEMPTS, 429, '尝试次数过多，请重新获取验证码');
  }
  if (hashSms(req.code) !== row.code_hash) {
    incrementSmsAttempts(phone);
    throw new HttpError(ERROR_CODES.AUTH_CODE_INVALID, 400, '验证码错误');
  }
  consumeSmsCode(phone);
  const { anon_user_id, segment } = resolveOrCreateUser({
    provider: 'sms',
    identifier: phone,
    segment: req.segment,
    linkAnonUserId: req.link_anon_user_id,
  });
  const token = issueSession(anon_user_id, 'sms');
  return {
    auth_token: token,
    anon_user_id,
    segment,
    provider: 'sms',
    bound_at: new Date().toISOString(),
  };
}

// ----------------- 微信 OAuth -----------------

export async function wechatAuth(req: AuthWechatRequest): Promise<AuthTokenResponse> {
  const openid = await exchangeWechatCode(req.code); // 未配置则抛 AUTH_PROVIDER_NOT_CONFIGURED
  const { anon_user_id, segment } = resolveOrCreateUser({
    provider: 'wechat',
    identifier: openid,
    segment: 'gaozhong', // 微信首次注册无 segment 选择，默认；可在设置里改
    linkAnonUserId: req.link_anon_user_id,
  });
  const token = issueSession(anon_user_id, 'wechat');
  return {
    auth_token: token,
    anon_user_id,
    segment,
    provider: 'wechat',
    bound_at: new Date().toISOString(),
  };
}

// ----------------- 魔法链接（email，无密码） -----------------

export async function magicSend(req: AuthMagicSendRequest): Promise<AuthMagicSendResponse> {
  const email = normalizeEmail(req.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '邮箱格式不正确');
  }
  const token = randomBytes(24).toString('hex');
  upsertMagicToken(email, hashMagic(token));
  const link = `${process.env.APP_PUBLIC_URL || ''}/auth/magic?token=${token}`;
  await dispatchMagicEmail(email, link);
  if (!process.env.EMAIL_PROVIDER) {
    return { ok: true, dev_token: token, message: '魔法链接令牌已生成（dev 模式，未真实发送）' };
  }
  return { ok: true, message: '登录链接已发送，请查收邮件' };
}

export function magicVerify(req: AuthMagicVerifyRequest): AuthTokenResponse {
  const token = String(req.token ?? '').trim();
  // 需要定位 email：magic_tokens 以 email 为主键，但校验时只有 token。
  // 为 O(1) 校验，这里按 token_hash 反查（表小，且只保留每邮箱最新一条，可接受）。
  const email = lookupMagicEmailByToken(hashMagic(token));
  if (!email) {
    throw new HttpError(ERROR_CODES.AUTH_CODE_INVALID, 400, '登录链接无效');
  }
  const row = getMagicToken(email);
  if (!row || row.consumed) {
    throw new HttpError(ERROR_CODES.AUTH_CODE_INVALID, 400, '登录链接已使用或无效');
  }
  const raw = row.created_at;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  if (Date.now() - new Date(normalized).getTime() > MAGIC_TOKEN_TTL_MS) {
    throw new HttpError(ERROR_CODES.AUTH_CODE_EXPIRED, 400, '登录链接已过期，请重新获取');
  }
  consumeMagicToken(email);
  const segment = req.segment ?? 'gaozhong';
  const { anon_user_id, segment: resolvedSegment } = resolveOrCreateUser({
    provider: 'magic',
    identifier: email,
    segment,
    linkAnonUserId: req.link_anon_user_id,
  });
  const authToken = issueSession(anon_user_id, 'magic');
  return {
    auth_token: authToken,
    anon_user_id,
    segment: resolvedSegment,
    provider: 'magic',
    bound_at: new Date().toISOString(),
  };
}

/** 按 token_hash 反查 email（magic_tokens 表小，仅每邮箱最新一条，全表扫描可接受）。 */
function lookupMagicEmailByToken(tokenHash: string): string | null {
  const rows = getDb()
    .prepare('SELECT email, token_hash FROM magic_tokens')
    .all() as Array<{ email: string; token_hash: string }>;
  for (const r of rows) if (r.token_hash === tokenHash) return r.email;
  return null;
}

// ----------------- 校验 / 状态 / 登出 -----------------

export type VerifyAuthResult =
  | { ok: true; anonUserId: string; segment: Segment; provider: AuthProvider; tier: LicenseTier }
  | { ok: false; reason: 'invalid' | 'expired' };

/** auth token 校验。超 TTL 视为过期（对称于 license 的 expires_at）。 */
export function verifyAuthToken(token: string | null | undefined): VerifyAuthResult {
  if (!token) return { ok: false, reason: 'invalid' };
  const session = getAuthSession(hashToken(token));
  if (!session) return { ok: false, reason: 'invalid' };
  const raw = session.created_at;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  if (Date.now() - new Date(normalized).getTime() > AUTH_TOKEN_TTL_MS) {
    return { ok: false, reason: 'expired' };
  }
  const user = getUser(session.anon_user_id);
  if (!user) return { ok: false, reason: 'invalid' };
  // 每 60s 才更新一次 last_seen_at，避免每个请求都写库
  const rawLast = session.last_seen_at;
  const normLast = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawLast)
    ? `${rawLast.replace(' ', 'T')}Z`
    : rawLast;
  const last = new Date(normLast).getTime();
  if (!Number.isFinite(last) || Date.now() - last > 60_000) {
    touchAuthSession(session.token_hash, new Date().toISOString());
  }
  // 真实账号默认免费档；订阅升档（subscriptions 表）后续可在此查档位。
  return {
    ok: true,
    anonUserId: session.anon_user_id,
    segment: user.segment as Segment,
    provider: session.provider as AuthProvider,
    tier: 'free',
  };
}

export function getAuthStatus(token: string | null | undefined): AuthStatusResponse {
  if (!token) {
    return { active: false, anon_user_id: null, segment: null, provider: null, providers: [] };
  }
  const v = verifyAuthToken(token);
  if (!v.ok) {
    return { active: false, anon_user_id: null, segment: null, provider: null, providers: [] };
  }
  const user = getUser(v.anonUserId);
  const creds = findCredentialsByUser(v.anonUserId);
  return {
    active: true,
    anon_user_id: v.anonUserId,
    segment: (user?.segment as Segment) ?? null,
    provider: v.provider,
    providers: creds.map((c) => c.provider),
    identifier: creds[0]?.identifier ?? null,
  };
}

export function getMe(token: string | null | undefined): AuthMeResponse {
  const v = verifyAuthToken(token);
  if (!v.ok) return { anon_user_id: null, segment: null, providers: [] };
  const acc = getAccount(v.anonUserId);
  const creds = findCredentialsByUser(v.anonUserId);
  return {
    anon_user_id: v.anonUserId,
    segment: acc?.segment ?? null,
    providers: creds.map((c) => c.provider),
    identifier: creds[0]?.identifier ?? null,
  };
}

export function logout(token: string | null | undefined): { ok: boolean } {
  if (token) deleteAuthSession(hashToken(token));
  return { ok: true };
}

// ----------------- 小工具 -----------------

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
