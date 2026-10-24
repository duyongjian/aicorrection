/**
 * 账户路由（INF-01）
 */
import { Router } from 'express';
import { z } from 'zod';
import { SEGMENTS } from '@aicorrection/shared';
import { createAccount, getAccount } from '../services/accountService';
import { ok } from '../utils/result';
import { validateBody } from '../middleware/validate';
import { HttpError } from '../middleware/errorHandler';
import { ERROR_CODES } from '@aicorrection/shared';

const router = Router();

const createSchema = z.object({
  segment: z.enum(SEGMENTS),
  client_hint: z.string().optional(),
});

router.post('/', validateBody(createSchema), (req, res) => {
  const acc = createAccount(req.body);
  res.json(ok(acc));
});

router.get('/:anon_user_id', (req, res) => {
  const acc = getAccount(req.params.anon_user_id);
  if (!acc) {
    throw new HttpError(ERROR_CODES.NOT_FOUND, 404, '用户不存在');
  }
  res.json(ok(acc));
});

export default router;
