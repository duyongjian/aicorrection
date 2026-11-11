/**
 * 管理后台鉴权中间件（独立于卡密/账号体系）
 *
 * 仅校验 x-admin-key（或 Authorization: Bearer）是否等于 env.ADMIN_API_KEY。
 * 本地默认 dev key 仅用于开发；生产应经 .env 配置强随机值，且不随分发默认开启。
 * 管理后台承载「改模型端点 / 改策略 / 改知识点库」等高权限操作，务必启用强 key。
 */
import type { RequestHandler } from 'express';
import { HttpError } from './errorHandler';
import { ERROR_CODES } from '@aicorrection/shared';
import { env } from '../config/env';

export const requireAdmin: RequestHandler = (req, res, next) => {
  const headerKey = req.header('x-admin-key');
  const bearer = req.header('authorization');
  const key = headerKey?.trim() || (bearer?.startsWith('Bearer ') ? bearer.slice(7).trim() : null);
  if (key && key === env.ADMIN_API_KEY) {
    next();
    return;
  }
  next(new HttpError(ERROR_CODES.AUTH_REQUIRED, 401, '管理后台需要有效的 x-admin-key'));
};
