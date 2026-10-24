/**
 * 看板路由（QAL-02）
 * GET /api/v1/dashboard/m1?window_days=14
 */
import { Router } from 'express';
import { z } from 'zod';
import { computeM1 } from '../services/dashboardService';
import { ok } from '../utils/result';

const router = Router();

router.get('/m1', (req, res, next) => {
  try {
    const windowDays = z.coerce
      .number()
      .int()
      .positive()
      .max(365)
      .default(14)
      .parse(req.query.window_days);
    const stats = computeM1(windowDays);
    res.json(ok(stats));
  } catch (e) {
    next(e);
  }
});

export default router;
