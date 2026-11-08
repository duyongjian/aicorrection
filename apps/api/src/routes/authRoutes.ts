/**
 * 真实账号路由（v0.2 地基）
 * 挂在 API_BASE_PATH/auth 下。注册/登录类端点为公开（门禁 PUBLIC_RULES 放行），
 * /me、/logout 需携带有效 token（由门禁识别后放行）。
 */
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { validateBody } from '../middleware/validate';
import { HttpError } from '../middleware/errorHandler';
import { verifyIdentityToken } from '../middleware/requireLicense';
import { ok } from '../utils/result';
import {
  registerWithPassword,
  loginWithPassword,
  sendSmsCode,
  verifySmsLogin,
  wechatAuth,
  magicSend,
  magicVerify,
  getAuthStatus,
  getMe,
  logout,
  deleteAccount,
} from '../services/authService';
import { AUTH_COOKIE_NAME, ERROR_CODES } from '@aicorrection/shared';

const router = Router();

/** 登录/注册成功后下发 uploads 专用 HttpOnly cookie（<img> 直连原图时承载凭证）。 */
function setUploadCookie(res: import('express').Response, token: string): void {
  // cookie 路径收窄到 uploads 前缀，且只读该路径；其余业务接口仍只认 header，
  // 避免 cookie 变成全站 CSRF 凭证（与 LICENSE_COOKIE_NAME 对称）。
  const maxAgeSec = Number(process.env.AUTH_TOKEN_TTL_MS ?? 30 * 24 * 60 * 60 * 1000) / 1000;
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: `${env.API_BASE_PATH}/uploads`,
    maxAge: maxAgeSec * 1000,
  });
}

/** 登出/注销时作废 uploads 专用 HttpOnly cookie（路径需与下发一致）。 */
function clearUploadCookie(res: import('express').Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, { path: `${env.API_BASE_PATH}/uploads` });
}

const registerSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  segment: z.enum(['kaoyan', 'kaogong', 'gaozhong']),
  link_anon_user_id: z.string().optional(),
});

router.post('/register', validateBody(registerSchema), async (req, res, next) => {
  try {
    const r = registerWithPassword(req.body);
    setUploadCookie(res, r.auth_token);
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  link_anon_user_id: z.string().optional(),
});

router.post('/login', validateBody(loginSchema), async (req, res, next) => {
  try {
    const r = loginWithPassword(req.body);
    setUploadCookie(res, r.auth_token);
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

const smsSendSchema = z.object({ phone: z.string().min(1) });

router.post('/sms/send', validateBody(smsSendSchema), async (req, res, next) => {
  try {
    const r = await sendSmsCode(req.body);
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

const smsVerifySchema = z.object({
  phone: z.string().min(1),
  code: z.string().min(1),
  segment: z.enum(['kaoyan', 'kaogong', 'gaozhong']),
  link_anon_user_id: z.string().optional(),
});

router.post('/sms/verify', validateBody(smsVerifySchema), async (req, res, next) => {
  try {
    const r = verifySmsLogin(req.body);
    setUploadCookie(res, r.auth_token);
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

const wechatSchema = z.object({
  code: z.string().min(1),
  link_anon_user_id: z.string().optional(),
});

router.post('/wechat', validateBody(wechatSchema), async (req, res, next) => {
  try {
    const r = await wechatAuth(req.body);
    setUploadCookie(res, r.auth_token);
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

const magicSendSchema = z.object({ email: z.string().min(1) });

router.post('/magic/send', validateBody(magicSendSchema), async (req, res, next) => {
  try {
    const r = await magicSend(req.body);
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

const magicVerifySchema = z.object({
  token: z.string().min(1),
  segment: z.enum(['kaoyan', 'kaogong', 'gaozhong']).optional(),
  link_anon_user_id: z.string().optional(),
});

router.post('/magic/verify', validateBody(magicVerifySchema), async (req, res, next) => {
  try {
    const r = magicVerify(req.body);
    setUploadCookie(res, r.auth_token);
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const token =
      (req.header('x-auth-token') || '').trim() ||
      (req.header('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    logout(token);
    clearUploadCookie(res);
    res.json(ok({ ok: true }));
  } catch (e) {
    next(e);
  }
});

/**
 * 注销账号并清除全部服务端记录（不可逆）。
 * 身份从请求 token 自身解析（auth 或 license token 均可，门禁无论是否启用都能校验），
 * 不依赖 res.locals.identity——因为 LICENSE_GATE_ENABLED=false 时门禁会直接 next()
 * 而不注入 identity。解析失败（无 token / token 失效）则 401。
 */
router.post('/delete-account', async (req, res, next) => {
  try {
    const token =
      (req.header('x-auth-token') || '').trim() ||
      (req.header('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const v = verifyIdentityToken(token || null);
    if (!v.ok) {
      throw new HttpError(ERROR_CODES.AUTH_REQUIRED, 401, '请先登录或激活后再注销');
    }
    const r = deleteAccount(v.anonUserId);
    clearUploadCookie(res);
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

router.get('/me', async (req, res, next) => {
  try {
    const token =
      (req.header('x-auth-token') || '').trim() ||
      (req.header('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    res.json(ok(getMe(token)));
  } catch (e) {
    next(e);
  }
});

router.get('/status', async (req, res, next) => {
  try {
    const token =
      (req.header('x-auth-token') || '').trim() ||
      (req.header('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    res.json(ok(getAuthStatus(token)));
  } catch (e) {
    next(e);
  }
});

export default router;
