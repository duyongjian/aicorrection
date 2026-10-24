/**
 * metadata 中间件（T4）
 * 从 req.ip 判断是否为内部账号，注入 req.is_internal。
 * 从请求 header/context 读取 channel / utm 参数，注入 req.metadata。
 */
import type { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 内部账号白名单文件路径 */
const INTERNAL_USERS_PATH = path.resolve(__dirname, '../../data/internal_users.json');

interface InternalUsersData {
  user_ids: string[];
}

let internalUserIds: string[] = [];
try {
  const raw = fs.readFileSync(INTERNAL_USERS_PATH, 'utf-8');
  internalUserIds = (JSON.parse(raw) as InternalUsersData).user_ids ?? [];
} catch {
  // 白名单文件不存在则空列表
}

/** 检查 IP 是否为内网地址 */
function isLocalIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

export function metadataMiddleware(req: Request, _res: Response, next: NextFunction): void {
  // is_internal：IP 为本地回环 或 anon_user_id 在白名单文件中
  const ip = (req.ip ?? '').toString();
  const isInternal = isLocalIp(ip) || internalUserIds.includes(req.body?.anon_user_id ?? '');
  req.is_internal = isInternal;

  // 从 query/body 读取渠道参数（供后续落库使用）
  req.metadata = {
    channel: (req.query.channel as string) || (req.body?.channel as string) || 'organic',
    utm_source: (req.query.utm_source as string) || (req.body?.utm_source as string) || undefined,
    utm_campaign: (req.query.utm_campaign as string) || (req.body?.utm_campaign as string) || undefined,
    is_internal: isInternal,
  };

  next();
}

declare global {
  namespace Express {
    interface Request {
      is_internal: boolean;
      metadata: {
        channel: string;
        utm_source: string | undefined;
        utm_campaign: string | undefined;
        is_internal: boolean;
      };
    }
  }
}
