/**
 * 请求体 zod 校验中间件
 */
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { fail } from '../utils/result';
import { ERROR_CODES } from '@aicorrection/shared';

type ZodSchema<T> = z.ZodType<T>;

// 表单/JSON 布尔字段兼容：'true'/'1'/true → true
export const boolFromForm = z.preprocess(
  (v) => v === true || v === 'true' || v === '1',
  z.boolean()
);

export function validateBody<T>(
  schema: ZodSchema<T>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const detail = result.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      res
        .status(400)
        .json(fail(ERROR_CODES.PARAM_INVALID, `参数校验失败: ${detail}`));
      return;
    }
    (req as Request & { validated?: T }).validated = result.data;
    next();
  };
}
