/**
 * 错误处理中间件 + 统一 HttpError（§7.6）
 * 业务降级态（OCR fail / analyzing / incomplete / followup-limit）走 HTTP 200 + data.status，
 * 仅参数错误 / 资源不存在 / 系统错误使用非零 code + 对应 HTTP。
 */
import type { Request, Response, NextFunction } from 'express';
import { fail } from '../utils/result';
import { ERROR_CODES } from '@aicorrection/shared';

export class HttpError extends Error {
  constructor(
    public code: number,
    public httpStatus: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json(fail(ERROR_CODES.NOT_FOUND, '接口不存在'));
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof HttpError) {
    res.status(err.httpStatus).json(fail(err.code, err.message));
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[errorHandler]', err);
  res.status(500).json(fail(ERROR_CODES.INTERNAL, '服务内部错误'));
}
