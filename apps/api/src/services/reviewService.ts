/**
 * 专家盲评服务（QAL-01）
 * 仅实现 API 回写 attributions.expert_accuracy（+ expert_consistency 预埋）；
 * 无独立评审 UI，由数据/测试用脚本抽样导出交专家。
 */
import {
  getAttribution,
  getPendingReviews,
  updateExpert,
} from '../models/attributionModel';
import { HttpError } from '../middleware/errorHandler';
import type {
  ReviewPendingItem,
  ReviewPendingResponse,
  ReviewWriteRequest,
  ReviewWriteResponse,
} from '@aicorrection/shared';

export class ReviewError extends HttpError {
  constructor(code: number, httpStatus: number, message: string) {
    super(code, httpStatus, message);
  }
}

export function writeExpertReview(
  attribution_id: string,
  req: ReviewWriteRequest
): ReviewWriteResponse {
  const attr = getAttribution(attribution_id);
  if (!attr) {
    throw new ReviewError(2001, 404, '归因记录不存在');
  }
  updateExpert(
    attribution_id,
    req.expert_accuracy,
    req.expert_consistency ?? null
  );
  return { ok: true };
}

export function getPendingReviewsList(
  limit: number,
  onlyUnrated: boolean
): ReviewPendingResponse {
  const items = getPendingReviews(limit, onlyUnrated) as ReviewPendingItem[];
  return { items };
}
