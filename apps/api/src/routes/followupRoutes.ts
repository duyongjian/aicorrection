/**
 * 追问路由（FLW-01）
 * POST /api/v1/attribution/:loop_id/followup
 */
import { Router } from 'express';
import { z } from 'zod';
import { followup } from '../services/followup/followupService';
import { ok } from '../utils/result';
import { validateBody } from '../middleware/validate';

const router = Router();

const schema = z.object({
  anon_user_id: z.string().min(1),
  message: z.string().min(1),
  followup_round: z.number().int().nonnegative().default(1),
});

router.post('/attribution/:loop_id/followup', validateBody(schema), async (req, res, next) => {
  try {
    const { loop_id } = req.params;
    const { anon_user_id, message, followup_round } = req.body;
    const data = await followup(loop_id, anon_user_id, message, followup_round);
    res.json(ok(data));
  } catch (e) {
    next(e);
  }
});

export default router;
