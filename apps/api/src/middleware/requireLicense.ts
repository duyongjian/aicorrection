/**
 * 卡密门禁中间件（线下分发 MVP）
 *
 * 默认关闭：只有显式 LICENSE_GATE_ENABLED=true 才生效，确保既有开发流程与
 * 全量单测行为零变化；分发启动脚本会强制开启。
 *
 * 挂载在 API_BASE_PATH 下、业务路由之前。静态前端在 base 之外，不受门禁，
 * 用户因此总能打开激活页。
 */
import type { Request, RequestHandler } from 'express';
import { HttpError } from './errorHandler';
import {
  ERROR_CODES,
  LICENSE_TOKEN_HEADER,
  LICENSE_COOKIE_NAME,
  AUTH_TOKEN_HEADER,
  AUTH_COOKIE_NAME,
} from '@aicorrection/shared';
import { isLicenseGateEnabled, verifyLicenseToken, getEntitlements } from '../services/licenseService';
import { verifyAuthToken } from '../services/authService';
import type { LicenseTier } from '@aicorrection/shared';

/** 手工解析 Cookie 头（避免为这一处引入 cookie-parser 依赖）。 */
function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    const value = part.slice(i + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/**
 * 从 header 取凭证，兼容 x-license-token 与 Authorization: Bearer。
 *
 * `allowUploadCookie` 仅由 requireLicense 在 GET /uploads/* 时置 true：浏览器 <img>
 * 无法带自定义 header，故额外接受兑换时下发的 HttpOnly cookie 作为**同一种凭证**。
 * 注意这不是放行 —— 该路径仍必须经过 verifyLicenseToken 的完整校验。
 * 业务接口一律只认 header，避免 cookie 变成全站 CSRF 凭证。
 */
export function extractLicenseToken(req: Request, allowUploadCookie = false): string | null {
  const direct = req.header(LICENSE_TOKEN_HEADER);
  if (direct && direct.trim()) return direct.trim();
  const auth = req.header('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (allowUploadCookie) return readCookie(req, LICENSE_COOKIE_NAME);
  return null;
}

/**
 * 统一身份凭证提取：auth header / license header / Authorization: Bearer 三源，
 * 再（仅 uploads 原图路径）接受 auth 或 license 专用 cookie。
 * auth 与 license token 都是 64 位 hex，无法从外形区分，故这里只负责「取到 token 字符串」，
 * 具体判哪种由 verifyIdentityToken 依次尝试两个校验器决定。
 */
export function extractIdentityToken(req: Request, allowUploadCookie = false): string | null {
  const auth = req.header(AUTH_TOKEN_HEADER);
  if (auth && auth.trim()) return auth.trim();
  const lic = req.header(LICENSE_TOKEN_HEADER);
  if (lic && lic.trim()) return lic.trim();
  const bearer = req.header('authorization');
  if (bearer && /^Bearer\s+/i.test(bearer)) return bearer.replace(/^Bearer\s+/i, '').trim();
  if (allowUploadCookie) {
    const c = readCookie(req, AUTH_COOKIE_NAME) || readCookie(req, LICENSE_COOKIE_NAME);
    if (c) return c;
  }
  return null;
}

/**
 * 身份校验：auth token 优先，license token 兜底（两者指向同一个 anon_user_id 身份流）。
 * 返回统一身份上下文，供业务路由（仍从请求体取前端自报 anon_user_id）与门禁共用。
 */
export function verifyIdentityToken(token: string | null | undefined): {
  ok: true;
  anonUserId: string;
  segment: string;
  tier: string;
  kind: 'auth' | 'license';
} | { ok: false; reason: 'invalid' | 'revoked' | 'expired' } {
  if (token) {
    const a = verifyAuthToken(token);
    if (a.ok) {
      return { ok: true, anonUserId: a.anonUserId, segment: a.segment, tier: a.tier, kind: 'auth' };
    }
    const l = verifyLicenseToken(token);
    if (l.ok) {
      return { ok: true, anonUserId: l.anonUserId, segment: l.segment, tier: l.tier, kind: 'license' };
    }
    return { ok: false, reason: l.reason === 'revoked' ? 'revoked' : l.reason === 'expired' ? 'expired' : 'invalid' };
  }
  return { ok: false, reason: 'invalid' };
}

/**
 * 无需凭证的路径（相对 API_BASE_PATH 挂载点）。
 * 仅放行兑换与状态查询：激活页本身必须可匿名访问，否则永远进不去。
 * /health 在 base 之外、/config/llm-status 在本中间件之前注册，两者天然放行。
 *
 * 明确的收紧取舍：/uploads/* **不在**放行清单内，原图也必须经验证凭证才能读取，
 * 只是允许用兑换时下发的 HttpOnly cookie 承载凭证（见 extractLicenseToken）。
 * /track 埋点与所有业务接口一律需要凭证。
 */
const PUBLIC_RULES: Array<{ method: string; path: string }> = [
  { method: 'POST', path: '/license/redeem' },
  { method: 'GET', path: '/license/status' },
  // 真实账号：注册/登录/发送验证码/微信/魔法链接 均为公开（用户尚未持有 token）
  { method: 'POST', path: '/auth/register' },
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/auth/sms/send' },
  { method: 'POST', path: '/auth/sms/verify' },
  { method: 'POST', path: '/auth/wechat' },
  { method: 'POST', path: '/auth/magic/send' },
  { method: 'POST', path: '/auth/magic/verify' },
  { method: 'GET', path: '/auth/status' },
];

export interface LicenseContext {
  anonUserId: string;
  segment: string;
  batchId: string;
}

export const requireLicense: RequestHandler = (req, res, next) => {
  if (!isLicenseGateEnabled()) {
    next();
    return;
  }
  if (PUBLIC_RULES.some((r) => r.method === req.method && r.path === req.path)) {
    next();
    return;
  }
  // 原图回显是浏览器 <img> 直连，无法带 header；仅此路径额外接受专用 cookie 承载
  // 同一份凭证（auth 或 license）。仍然完整走 verifyIdentityToken，不存在匿名放行。
  const isUploadAsset = req.method === 'GET' && req.path.startsWith('/uploads/');
  const v = verifyIdentityToken(extractIdentityToken(req, isUploadAsset));
  if (!v.ok) {
    const code =
      v.reason === 'expired'
        ? ERROR_CODES.LICENSE_EXPIRED
        : v.reason === 'revoked'
          ? ERROR_CODES.LICENSE_REVOKED
          : ERROR_CODES.LICENSE_REQUIRED;
    const message =
      v.reason === 'expired'
        ? '卡密已过期，请联系发放人'
        : v.reason === 'revoked'
          ? '卡密已停用，请联系发放人'
          : '请先使用卡密激活或登录账号后再使用';
    // 用 next(err) 而非 throw：Express 4 对同步 throw 的捕获依赖 router 实现细节，
    // 显式交给错误中间件更稳妥，且能保证 errorHandler 统一输出 {code,message} 信封。
    next(new HttpError(code, 401, message));
    return;
  }
  // 统一身份上下文（业务路由仍从请求体取前端自报 anon_user_id，此字段仅作闸门产物）。
  res.locals.identity = {
    anonUserId: v.anonUserId,
    segment: v.segment,
    tier: v.tier,
    entitlements: getEntitlements(v.tier as LicenseTier),
    kind: v.kind,
  };
  // 兼容字段：license 凭证命中时也保持旧 res.locals.license（暂无业务消费，保留稳妥）。
  if (v.kind === 'license') {
    res.locals.license = { anonUserId: v.anonUserId, segment: v.segment, batchId: '' } as LicenseContext;
  }
  next();
};
