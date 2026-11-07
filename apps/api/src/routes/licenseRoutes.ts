/**
 * 卡密路由（线下分发 MVP）
 *  - POST /api/v1/license/redeem  公开：兑换卡密，返回凭证 + 已绑定的匿名账号
 *  - GET  /api/v1/license/status  公开（自身校验）：始终 200，失效以 active:false 表达
 * 管理动作（发卡 / 停用 / 列表）只走本机 CLI，不暴露 HTTP 管理接口，减少攻击面。
 */
import { Router } from 'express';
import { z } from 'zod';
import { SEGMENTS, LICENSE_COOKIE_NAME } from '@aicorrection/shared';
import { env } from '../config/env';
import { ok } from '../utils/result';
import { validateBody } from '../middleware/validate';
import { extractLicenseToken } from '../middleware/requireLicense';
import { redeemLicense, getLicenseStatus } from '../services/licenseService';

const router = Router();

/** cookie 只发给 uploads 前缀，业务请求不会自动带上它。 */
const UPLOAD_COOKIE_PATH = `${env.API_BASE_PATH}/uploads`;

const redeemSchema = z.object({
  code: z.string().min(1, '卡密不能为空'),
  segment: z.enum(SEGMENTS),
});

router.post('/redeem', validateBody(redeemSchema), (req, res) => {
  const data = redeemLicense(req.body);
  // 浏览器 <img src="/api/v1/uploads/..."> 不能带自定义 header，靠这个 HttpOnly
  // cookie 携带同一份凭证。它仍是凭证（需完整校验），不是匿名放行；
  // path 收窄到 uploads，且 requireLicense 只在 /uploads/* 接受它。
  // 线下分发走 http（localhost/局域网），故不设 secure；sameSite=lax 防跨站携带。
  res.cookie(LICENSE_COOKIE_NAME, data.license_token, {
    httpOnly: true,
    sameSite: 'lax',
    path: UPLOAD_COOKIE_PATH,
    secure: false,
  });
  res.json(ok(data));
});

router.get('/status', (req, res) => {
  const status = getLicenseStatus(extractLicenseToken(req));
  if (!status.active) {
    // 凭证失效时同步清掉图片 cookie，避免留下仍可读取原图的孤儿凭证。
    res.clearCookie(LICENSE_COOKIE_NAME, { path: UPLOAD_COOKIE_PATH, httpOnly: true, sameSite: 'lax' });
  }
  res.json(ok(status));
});

export default router;
