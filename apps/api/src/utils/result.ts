/**
 * 统一响应信封构造（§7.6）
 */
import type { ApiResponse } from '@aicorrection/shared';
import { ERROR_CODES } from '@aicorrection/shared';

export function ok<T>(data: T, message = 'ok'): ApiResponse<T> {
  return { code: ERROR_CODES.SUCCESS, data, message };
}

export function fail<T>(
  code: number,
  message: string,
  data: T = null as unknown as T
): ApiResponse<T> {
  return { code, data, message };
}
