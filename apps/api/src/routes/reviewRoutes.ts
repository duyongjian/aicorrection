/**
 * 专家盲评路由（QAL-01）
 * POST /api/v1/review/attribution/:attribution_id  → 回写
 * GET  /api/v1/review/pending?limit=20&only_unrated=true → 抽样
 */
import { Router } from 'express';
import { z } from 'zod';
import { writeExpertReview, getPendingReviewsList } from '../services/reviewService';
import { ok } from '../utils/result';
import { validateBody } from '../middleware/validate';

const router = Router();

const writeSchema = z.object({
  expert_id: z.string().min(1),
  expert_accuracy: z.enum(['accurate', 'inaccurate']),
  expert_consistency: z.enum(['agree', 'disagree']).optional(),
  note: z.string().optional(),
});

router.post('/attribution/:attribution_id', validateBody(writeSchema), (req, res, next) => {
  try {
    const data = writeExpertReview(req.params.attribution_id, req.body);
    res.json(ok(data));
  } catch (e) {
    next(e);
  }
});

router.get('/pending', (req, res, next) => {
  try {
    const limit = z.coerce
      .number()
      .int()
      .positive()
      .max(100)
      .default(20)
      .parse(req.query.limit);
    const onlyUnrated = req.query.only_unrated === 'false' ? false : true;
    const data = getPendingReviewsList(limit, onlyUnrated);
    res.json(ok(data));
  } catch (e) {
    next(e);
  }
});

export default router;
