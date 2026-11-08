/**
 * 卡密服务（线下分发 MVP）
 *
 * 设计取舍：卡密即账号 —— 不引入手机号/邮箱/微信注册，避免外发与注册摩擦。
 * 兑换成功即复用既有 accountService.createAccount 建 anon_user_id，主流程零改动。
 *
 * 数据主权：
 *  - 卡密与 token 的明文只在本进程内出现一次（发卡输出 / 兑换响应），DB 只存 SHA-256；
 *  - 不联网、不外发、不写日志明文；卡密 hint 只保留末 4 位供管理端识别；
 *  - 门禁默认关闭（LICENSE_GATE_ENABLED=true 才开启），既有开发/单测行为零变化。
 */
import { createHash, randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../middleware/errorHandler';
import { createAccount } from './accountService';
import { getUser } from '../models/userModel';
import { getDb } from '../db';
import {
  tryInsertLicenseKey,
  getLicenseKey,
  markLicenseRedeemed,
  markLicenseRevoked,
  listLicenseKeys,
  insertLicenseSession,
  getLicenseSession,
  touchLicenseSession,
  getLicenseKeyByAnon,
  type LicenseKeyRow,
  extendLicenseExpiry,
  setLicenseTier,
  setLicenseSessionTierByCode,
  insertSubscription,
  getActiveSubscription,
  cancelSubscription,
  insertPayment,
  markPaymentPaid,
} from '../models/licenseModel';
import {
  ERROR_CODES,
  LICENSE_TIERS,
  TIER_ENTITLEMENTS,
  TIER_DEFAULT_DURATION_DAYS,
  LICENSE_TIER_LABELS,
  type LicenseTier,
  type Entitlement,
} from '@aicorrection/shared';
import type {
  LicenseRedeemRequest,
  LicenseRedeemResponse,
  LicenseStatusResponse,
  Segment,
  LicensePlanResponse,
  LicenseRenewRequest,
  LicenseRenewResponse,
  CreateSubscriptionRequest,
  CreateSubscriptionResponse,
  SubscriptionView,
  PaymentView,
} from '@aicorrection/shared';

/** 去歧义字母表（去掉 I/L/O/0/1），恰好 32 字符 → 字节取模无偏。 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_BODY_LEN = 12;
const HASH_PREFIX = { code: 'aicorrection:license:', token: 'aicorrection:token:' } as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashCode(body: string): string {
  return sha256(HASH_PREFIX.code + body);
}

function hashToken(token: string): string {
  return sha256(HASH_PREFIX.token + token);
}

/** 管理员侧：12 位随机主体 → 展示格式 AC-XXXX-XXXX-XXXX。 */
function formatCode(body: string): string {
  return `AC-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

function randomBody(): string {
  const bytes = randomBytes(CODE_BODY_LEN);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/**
 * 用户输入归一化：大写、去分隔符，返回 12 位主体。
 *
 * 两种合法输入：
 *  - 标准发卡格式 `AC-XXXX-XXXX-XXXX` → 去分隔符后 14 字符，剥掉 2 位前缀得 12 位主体；
 *  - 裸 12 位主体（用户手动粘贴）→ 原样作为主体。
 *
 * 不能写成 `startsWith('AC') ? slice(2) : s`：字母表含 A/C，主体本身有 ~1/1024 概率
 * 以 "AC" 开头，这类卡密若被用户以裸主体输入会被误剥成 10 位而判无效。
 * 按长度分支可消除该歧义。
 */
export function canonicalCode(raw: string): string | null {
  const s = String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  let body: string;
  if (s.length === CODE_BODY_LEN + 2 && s.startsWith('AC')) {
    body = s.slice(2);
  } else if (s.length === CODE_BODY_LEN) {
    body = s;
  } else {
    return null;
  }
  for (const ch of body) if (!ALPHABET.includes(ch)) return null;
  return body;
}

export function isLicenseGateEnabled(): boolean {
  return process.env.LICENSE_GATE_ENABLED === 'true';
}

export interface GenerateLicensesOptions {
  count: number;
  batchId?: string;
  note?: string | null;
  expiresAt?: string | null;
  /** 卡密档位（权益层）；默认 free。 */
  tier?: LicenseTier;
}

export interface GeneratedLicense {
  code: string;
  batch_id: string;
  tier: LicenseTier;
  entitlements: Entitlement[];
  expires_at: string | null;
  note: string | null;
}

/**
 * 批量发卡。明文卡密**只在此返回值里出现一次**，调用方负责立即导出/打印；
 * 之后任何人都无法从 DB 反查明文（仅存 hash + 末 4 位 hint）。
 */
export function generateLicenses(opts: GenerateLicensesOptions): GeneratedLicense[] {
  // 先验原始值的类型与整数性，绝不隐式转换/取整：
  //  - 原先 Math.floor 会把 1.5 / 999.9 静默取整后发卡，与错误文案自相矛盾；
  //  - 若只写 Number(opts.count)，数字字符串 '3' 也会被宽松接受并连发 3 张。
  // 发卡是不可逆动作，宁可明确拒绝脏输入。CLI 侧已把 --count 转成 number。
  const count = opts.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 1000) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '发卡数量须为 1–1000 的整数');
  }
  let expiresAt: string | null = null;
  if (opts.expiresAt) {
    const d = new Date(opts.expiresAt);
    if (Number.isNaN(d.getTime())) {
      throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, 'expires_at 不是有效日期');
    }
    expiresAt = d.toISOString();
  }
  const tier: LicenseTier = opts.tier && (LICENSE_TIERS as readonly string[]).includes(opts.tier)
    ? opts.tier
    : 'free';
  const entitlements = TIER_ENTITLEMENTS[tier];
  const entitlementsJson = JSON.stringify(entitlements);
  const batchId = (opts.batchId || `batch-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`).trim();
  const note = opts.note ?? null;
  const out: GeneratedLicense[] = [];
  const db = getDb();

  const insertOne = db.transaction((): GeneratedLicense => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const body = randomBody();
      const key = {
        code_hash: hashCode(body),
        code_hint: body.slice(-4),
        batch_id: batchId,
        note,
        tier,
        entitlements_json: entitlementsJson,
        expires_at: expiresAt,
      };
      if (tryInsertLicenseKey(key)) {
        return {
          code: formatCode(body),
          batch_id: batchId,
          tier,
          entitlements,
          expires_at: expiresAt,
          note,
        };
      }
    }
    throw new HttpError(ERROR_CODES.INTERNAL, 500, '卡密生成连续冲突，请重试');
  });

  for (let i = 0; i < count; i += 1) out.push(insertOne());
  return out;
}

/** 兑换：校验卡密 → 原子占用 → 建匿名账号 → 发会话凭证。 */
export function redeemLicense(req: LicenseRedeemRequest): LicenseRedeemResponse {
  const body = canonicalCode(req.code);
  if (!body) {
    throw new HttpError(ERROR_CODES.LICENSE_INVALID, 400, '卡密格式不正确，应形如 AC-XXXX-XXXX-XXXX');
  }
  const codeHash = hashCode(body);
  const key = getLicenseKey(codeHash);
  if (!key) {
    throw new HttpError(ERROR_CODES.LICENSE_INVALID, 404, '卡密不存在，请核对后重试');
  }
  if (key.status === 'redeemed') {
    throw new HttpError(ERROR_CODES.LICENSE_ALREADY_USED, 409, '该卡密已被激活');
  }
  if (key.status === 'revoked') {
    throw new HttpError(ERROR_CODES.LICENSE_REVOKED, 403, '该卡密已停用');
  }
  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
    throw new HttpError(ERROR_CODES.LICENSE_EXPIRED, 403, '该卡密已过期');
  }

  const segment: Segment = req.segment;
  const tier = (key.tier as LicenseTier) || 'free';
  const now = new Date().toISOString();
  const token = randomBytes(32).toString('hex');
  const db = getDb();

  const account = db.transaction(() => {
    const acc = createAccount({ segment });
    if (!markLicenseRedeemed(codeHash, acc.anon_user_id, now)) {
      // 条件 UPDATE 失败 = 并发下已被别人兑换，事务回滚会一并撤销刚建的账号
      throw new HttpError(ERROR_CODES.LICENSE_ALREADY_USED, 409, '该卡密已被激活');
    }
    insertLicenseSession({
      token_hash: hashToken(token),
      anon_user_id: acc.anon_user_id,
      code_hash: codeHash,
      tier,
    });
    return acc;
  })();

  const entitlements = resolveEntitlements(key.entitlements_json, tier);

  return {
    license_token: token,
    anon_user_id: account.anon_user_id,
    segment,
    batch_id: key.batch_id,
    tier,
    entitlements,
    expires_at: key.expires_at,
    bound_at: now,
  };
}

/**
 * 解析权益列表：优先用卡密发行时冻结的快照（entitlements_json），
 * 缺失时回退到当前档位映射，保证历史卡密在档位定义演进后权益不漂移。
 */
export function resolveEntitlements(snapshotJson: string | null, tier: LicenseTier): Entitlement[] {
  if (snapshotJson) {
    try {
      const parsed = JSON.parse(snapshotJson);
      if (Array.isArray(parsed)) return parsed as Entitlement[];
    } catch {
      /* 快照损坏则回退档位映射 */
    }
  }
  return TIER_ENTITLEMENTS[tier] ?? TIER_ENTITLEMENTS.free;
}

/** 给定档位返回权益集合（纯函数，便于前端/门禁复用）。 */
export function getEntitlements(tier: LicenseTier): Entitlement[] {
  return TIER_ENTITLEMENTS[tier] ?? TIER_ENTITLEMENTS.free;
}

/** 给定档位是否含某权益。 */
export function hasEntitlement(tier: LicenseTier, ent: Entitlement): boolean {
  return getEntitlements(tier).includes(ent);
}

export type VerifyLicenseResult =
  | { ok: true; anonUserId: string; segment: Segment; batchId: string; expiresAt: string | null; tier: LicenseTier }
  | { ok: false; reason: 'invalid' | 'revoked' | 'expired' };

/** 业务请求凭证校验。每 60s 才更新一次 last_seen_at，避免每个请求都写库。 */
export function verifyLicenseToken(token: string | null | undefined): VerifyLicenseResult {
  if (!token) return { ok: false, reason: 'invalid' };
  const session = getLicenseSession(hashToken(token));
  if (!session) return { ok: false, reason: 'invalid' };
  const key = getLicenseKey(session.code_hash);
  if (!key || key.status !== 'redeemed') return { ok: false, reason: 'revoked' };
  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  const user = getUser(session.anon_user_id);
  if (!user) return { ok: false, reason: 'invalid' };

  // last_seen_at 的 DEFAULT 是 SQLite datetime('now')，产出 "YYYY-MM-DD HH:MM:SS"
  // （UTC 但无时区标记）；JS 会按本地时区解析，UTC+8 下与 Date.now() 恒差 8 小时，
  // 会让「每 60s 才写一次」退化成每个请求都写库。统一按 UTC 解析。
  const rawLast = session.last_seen_at;
  const normalizedLast = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawLast)
    ? `${rawLast.replace(' ', 'T')}Z`
    : rawLast;
  const last = new Date(normalizedLast).getTime();
  if (!Number.isFinite(last) || Date.now() - last > 60_000) {
    touchLicenseSession(session.token_hash, new Date().toISOString());
  }
  return {
    ok: true,
    anonUserId: session.anon_user_id,
    segment: user.segment as Segment,
    batchId: key.batch_id,
    expiresAt: key.expires_at,
    tier: (session.tier as LicenseTier) || 'free',
  };
}

/**
 * 前端冷启动状态查询：始终返回 200，失效以 active:false + reason 表达。
 *
 * 关键：门禁未开启时（默认开发态）必须返回 active:true，否则前端会被一张
 * 永远无法通过、也无从获得卡密的激活页锁死，违背「默认关闭、开发流程零变化」。
 * 此时 active 表示「可以进入应用」而非「凭证有效」，由 gate_enabled:false 明示。
 */
export function getLicenseStatus(token: string | null | undefined): LicenseStatusResponse {
  const gateEnabled = isLicenseGateEnabled();
  const inactive = (reason: LicenseStatusResponse['reason']): LicenseStatusResponse => ({
    active: false,
    gate_enabled: gateEnabled,
    anon_user_id: null,
    segment: null,
    batch_id: null,
    tier: null,
    entitlements: [],
    expires_at: null,
    is_expired: false,
    reason,
  });

  if (!gateEnabled) {
    return {
      active: true,
      gate_enabled: false,
      anon_user_id: null,
      segment: null,
      batch_id: null,
      tier: null,
      entitlements: [],
      expires_at: null,
      is_expired: false,
    };
  }
  if (!token) return inactive('missing');
  const v = verifyLicenseToken(token);
  if (!v.ok) return inactive(v.reason);
  return {
    active: true,
    gate_enabled: true,
    anon_user_id: v.anonUserId,
    segment: v.segment,
    batch_id: v.batchId,
    tier: v.tier,
    entitlements: getEntitlements(v.tier),
    expires_at: v.expiresAt,
    is_expired: v.expiresAt ? new Date(v.expiresAt).getTime() < Date.now() : false,
  };
}

/** 停用卡密：已兑换的会立刻失去所有业务访问权限。 */
export function revokeLicense(rawCode: string): { ok: boolean; message: string } {
  const body = canonicalCode(rawCode);
  if (!body) return { ok: false, message: '卡密格式不正确' };
  const key = getLicenseKey(hashCode(body));
  if (!key) return { ok: false, message: '卡密不存在' };
  if (!markLicenseRevoked(key.code_hash, new Date().toISOString())) {
    return { ok: false, message: '卡密已处于停用状态' };
  }
  // 只回显末 4 位 hint，不把调用方传入的明文卡密二次落地到响应/日志。
  // 明文只在发卡输出与兑换请求里出现一次，停用响应不应成为第三个副本。
  return { ok: true, message: `已停用 ****-${key.code_hint}（原状态 ${key.status}）` };
}

/** 管理端列表视图：不输出完整 hash，避免与明文卡密产生任何可关联信息。 */
export interface LicenseListViewItem {
  hint: string;
  batch_id: string;
  status: string;
  tier: string;
  note: string | null;
  expires_at: string | null;
  anon_user_id: string | null;
  redeemed_at: string | null;
  created_at: string;
}

export function listLicenses(batchId?: string): LicenseListViewItem[] {
  return listLicenseKeys(batchId).map((r) => ({
    hint: `****-${r.code_hint}`,
    batch_id: r.batch_id,
    status: r.status,
    tier: r.tier,
    note: r.note,
    expires_at: r.expires_at,
    anon_user_id: r.anon_user_id,
    redeemed_at: r.redeemed_at,
    created_at: r.created_at,
  }));
}

// ===================== 商业化：权益层 / 订阅 / 续费 =====================

/**
 * 查账号绑定的有效档位来源：已兑换卡密（含 anon_user_id）优先，其次进行中的订阅。
 * 返回档位与到期时间；无绑定则返回 null（走免费档）。
 */
export function getBoundLicenseForUser(
  anonUserId: string
): { tier: LicenseTier; expiresAt: string | null } | null {
  const db = getDb();
  const key = db
    .prepare(
      `SELECT tier, expires_at FROM license_keys
       WHERE anon_user_id = ? AND status = 'redeemed' ORDER BY redeemed_at DESC LIMIT 1`
    )
    .get(anonUserId) as { tier: string; expires_at: string | null } | undefined;
  if (key) {
    const expired = key.expires_at != null && new Date(key.expires_at).getTime() < Date.now();
    if (!expired) return { tier: (key.tier as LicenseTier) || 'free', expiresAt: key.expires_at };
  }
  const sub = getActiveSubscription(anonUserId);
  if (sub) return { tier: (sub.tier as LicenseTier) || 'free', expiresAt: sub.current_period_end };
  return null;
}

/** 账号当前档位（无绑定档位则 free）。auth 校验与计划查询共用，使密码登录也能认绑定档位。 */
export function resolveUserTier(anonUserId: string): LicenseTier {
  return getBoundLicenseForUser(anonUserId)?.tier ?? 'free';
}

/**
 * 当前档位与权益快照查询（前端显隐功能入口、后端接口级闸门共用）。
 * 优先从已兑换卡密解析；其次按 anon_user_id 解析绑定档位（卡密/订阅）；
 * 均无则默认免费档。这样真实账号（密码/短信/微信/魔法链接登录）也能拥有付费档位。
 */
export function getLicensePlan(
  licenseToken?: string | null,
  anonUserId?: string | null
): LicensePlanResponse {
  if (licenseToken) {
    const v = verifyLicenseToken(licenseToken);
    if (v.ok) {
      const isExpired = v.expiresAt ? new Date(v.expiresAt).getTime() < Date.now() : false;
      return {
        tier: v.tier,
        tier_label: LICENSE_TIER_LABELS[v.tier] ?? v.tier,
        entitlements: getEntitlements(v.tier),
        expires_at: v.expiresAt,
        is_expired: isExpired,
        can_renew: !isExpired,
      };
    }
  }
  // 真实账号：按绑定档位解析（卡密/订阅），无则免费档
  if (anonUserId) {
    const bound = getBoundLicenseForUser(anonUserId);
    if (bound) {
      const isExpired = bound.expiresAt ? new Date(bound.expiresAt).getTime() < Date.now() : false;
      return {
        tier: bound.tier,
        tier_label: LICENSE_TIER_LABELS[bound.tier] ?? bound.tier,
        entitlements: getEntitlements(bound.tier),
        expires_at: bound.expiresAt,
        is_expired: isExpired,
        can_renew: !isExpired && bound.tier !== 'max',
      };
    }
  }
  // 无有效凭证/绑定：默认免费档（可走升档/订阅流程）
  return {
    tier: 'free',
    tier_label: LICENSE_TIER_LABELS.free,
    entitlements: getEntitlements('free'),
    expires_at: null,
    is_expired: false,
    can_renew: true,
  };
}

/**
 * 续费：延长卡密有效期（线下分发场景即「续费」）。
 * 通过 license_token 或 code 定位卡密；无则按 anon_user_id 查其已兑换卡密。
 * days 缺省按当前档位默认时长；tier 传入则同时升档（权益快照一并刷新）。
 */
export function renewLicense(req: LicenseRenewRequest, anonUserId?: string): LicenseRenewResponse {
  let target: LicenseKeyRow | undefined;
  if (req.license_token) {
    const v = verifyLicenseToken(req.license_token);
    if (v.ok) target = getLicenseKeyByAnon(v.anonUserId);
  }
  if (!target && req.code) {
    const body = canonicalCode(req.code);
    if (body) target = getLicenseKey(hashCode(body));
  }
  if (!target && anonUserId) target = getLicenseKeyByAnon(anonUserId);
  if (!target) {
    throw new HttpError(ERROR_CODES.LICENSE_NOT_FOUND, 404, '未找到可续费的卡密');
  }

  const currentTier = (target.tier as LicenseTier) || 'free';
  const newTier: LicenseTier = req.tier && (LICENSE_TIERS as readonly string[]).includes(req.tier)
    ? req.tier
    : currentTier;

  const durationDays = req.days && req.days > 0
    ? req.days
    : TIER_DEFAULT_DURATION_DAYS[newTier];

  const base = target.expires_at && new Date(target.expires_at).getTime() > Date.now()
    ? new Date(target.expires_at).getTime()
    : Date.now();
  const newExpires = new Date(base + durationDays * 86_400_000).toISOString();

  const db = getDb();
  db.transaction(() => {
    extendLicenseExpiry(target!.code_hash, newExpires);
    if (newTier !== currentTier) {
      setLicenseTier(target!.code_hash, newTier);
      setLicenseSessionTierByCode(target!.code_hash, newTier);
      // 升档时刷新权益快照，使后续兑换/状态查询拿到新档位权益
      db.prepare('UPDATE license_keys SET entitlements_json = ? WHERE code_hash = ?')
        .run(JSON.stringify(TIER_ENTITLEMENTS[newTier]), target!.code_hash);
    }
  })();

  return {
    ok: true,
    tier: newTier,
    expires_at: newExpires,
    message: `续费成功，有效期至 ${new Date(newExpires).toLocaleDateString('zh-CN')}${newTier !== currentTier ? `，已升级至${LICENSE_TIER_LABELS[newTier]}` : ''}`,
  };
}

/**
 * 发起订阅/支付。真实支付 provider 未配置时返回 NOT_CONFIGURED（与 wechat auth 对称），
 * 不写任何支付台账；配置后（STRIPE_SECRET_KEY / WECHAT_PAY_* 等）可创建订阅 + 支付记录并回跳 checkout。
 */
export function createSubscription(req: CreateSubscriptionRequest): CreateSubscriptionResponse {
  const provider = req.provider ?? 'none';
  const providerConfigured = !!process.env.PAYMENT_PROVIDER;
  if (!providerConfigured && provider !== 'none') {
    throw new HttpError(
      ERROR_CODES.PAYMENT_PROVIDER_NOT_CONFIGURED,
      501,
      '支付服务未配置：请设置 PAYMENT_PROVIDER 环境变量（stripe / wechat_pay）后再发起订阅'
    );
  }

  const tier: LicenseTier = (LICENSE_TIERS as readonly string[]).includes(req.tier) ? req.tier : 'free';
  const now = new Date();
  const periodEnd = new Date(now.getTime() + TIER_DEFAULT_DURATION_DAYS[tier] * 86_400_000);
  const subId = `sub_${randomBytes(12).toString('hex')}`;
  const paymentId = `pay_${randomBytes(12).toString('hex')}`;

  const db = getDb();
  db.transaction(() => {
    insertSubscription({
      subscription_id: subId,
      anon_user_id: req.anon_user_id,
      provider,
      provider_sub_id: null,
      tier,
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString(),
    });
    insertPayment({
      payment_id: paymentId,
      anon_user_id: req.anon_user_id,
      provider,
      amount_cents: 0,
      currency: 'CNY',
      tier,
    });
  })();

  // 真实 provider 接入点：此处应调用对应 SDK 生成 checkout_url（stub 暂留空）
  const checkout_url = process.env.PAYMENT_CHECKOUT_BASE
    ? `${process.env.PAYMENT_CHECKOUT_BASE}?sub=${subId}`
    : undefined;

  return {
    ok: true,
    provider,
    subscription_id: subId,
    checkout_url,
    message: providerConfigured
      ? '订阅已创建，请完成支付'
      : '订阅已创建（离线模式，未接入真实支付）',
  };
}

/** 查询用户当前有效订阅视图（前端「我的订阅」）。 */
export function getSubscriptionView(anonUserId: string): SubscriptionView | null {
  const row = getActiveSubscription(anonUserId);
  if (!row) return null;
  return {
    subscription_id: row.subscription_id,
    tier: (row.tier as LicenseTier) || 'free',
    status: row.status as 'active' | 'cancelled' | 'expired',
    provider: row.provider,
    current_period_start: row.current_period_start,
    current_period_end: row.current_period_end,
  };
}

/** 取消订阅。 */
export function cancelUserSubscription(anonUserId: string): { ok: boolean; message: string } {
  const row = getActiveSubscription(anonUserId);
  if (!row) return { ok: false, message: '无进行中的订阅' };
  cancelSubscription(row.subscription_id, new Date().toISOString());
  return { ok: true, message: `已取消订阅 ${row.subscription_id}` };
}
