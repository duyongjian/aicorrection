/**
 * 认可/评分路由（ATT-04）
 * POST /api/v1/attribution/:loop_id/rate
 * attr_dislike 已废除，统一用 rate_action='inaccurate'。
 */
import { Router } from 'express';
import { z } from 'zod';
import { RATE_ACTIONS, INACCURATE_REASONS } from '@aicorrection/shared';
import { updateRateAction } from '../models/attributionModel';
import { ok } from '../utils/result';
import { validateBody } from '../middleware/validate';
import { HttpError } from '../middleware/errorHandler';
import { ERROR_CODES } from '@aicorrection/shared';

const router = Router();

const schema = z.object({
  anon_user_id: z.string().min(1),
  rate_action: z.enum(RATE_ACTIONS),
  rate_score: z.number().int().min(1).max(5).optional(),
  inaccurate_reason: z.enum(INACCURATE_REASONS).optional(),
  inaccurate_text: z.string().optional(),
});

router.post('/attribution/:loop_id/rate', validateBody(schema), (req, res, next) => {
  try {
    const { loop_id } = req.params;
    const { rate_action, inaccurate_reason } = req.body;
    const result = updateRateAction(loop_id, rate_action, inaccurate_reason);
    if (!result.found) {
      throw new HttpError(ERROR_CODES.NOT_FOUND, 404, '该 loop 暂无归因记录');
    }
    res.json(ok({ ok: true, rate_action }));
  } catch (e) {
    next(e);
  }
});

export default router;
