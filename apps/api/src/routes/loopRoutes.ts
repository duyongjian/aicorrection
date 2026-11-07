/**
 * v0.3 闭环会话流路由（R07 闭环完成 / 状态聚合）。挂在 API_BASE_PATH/loop 下。
 */
import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate';
import { ok } from '../utils/result';
import { completeLoop, getLoopSummary } from '../services/loopService';

const router = Router();

router.post(
  '/complete',
  validateBody(z.object({ loop_id: z.string().min(1), anon_user_id: z.string().min(1) })),
  (req, res, next) => {
    try {
      const r = completeLoop(req.body.loop_id, req.body.anon_user_id);
      res.json(ok(r));
    } catch (e) {
      next(e);
    }
  }
);

router.get('/:loop_id', (req, res, next) => {
  try {
    const r = getLoopSummary(req.params.loop_id);
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

export default router;
