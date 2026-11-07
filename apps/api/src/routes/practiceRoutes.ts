/**
 * v0.2 闭环补全路由（R04 同类题 / R05 复述 / R06 追问验证）
 * 挂在 API_BASE_PATH/learn 下。anon_user_id 由前端随请求体携带（与上传/归因一致），
 * 门禁只负责「凭证是否有效」（见 requireLicense）。
 */
import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate';
import { ok } from '../utils/result';
import {
  generatePractice,
  gradePractice,
  submitRestate,
  verifyProbe,
  verify,
} from '../services/learningService';

const router = Router();

const loopBody = z.object({
  loop_id: z.string().min(1),
  anon_user_id: z.string().min(1),
});

router.post('/practice/generate', validateBody(loopBody), (req, res, next) => {
  try {
    const r = generatePractice(req.body.loop_id, req.body.anon_user_id);
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

router.post(
  '/practice/grade',
  validateBody(z.object({ practice_id: z.string().min(1), user_answer: z.string().min(1), anon_user_id: z.string().min(1) })),
  (req, res, next) => {
    try {
      const r = gradePractice(req.body.practice_id, req.body.user_answer);
      res.json(ok(r));
    } catch (e) {
      next(e);
    }
  }
);

router.post('/restate', validateBody(z.object({ loop_id: z.string().min(1), text: z.string().min(1), anon_user_id: z.string().min(1) })), (req, res, next) => {
  try {
    const r = submitRestate(req.body.loop_id, req.body.anon_user_id, req.body.text);
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

router.post('/verify/probe', validateBody(loopBody), (req, res, next) => {
  try {
    const r = verifyProbe(req.body.loop_id, req.body.anon_user_id);
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

router.post('/verify', validateBody(z.object({ loop_id: z.string().min(1), response: z.string().min(1), anon_user_id: z.string().min(1) })), (req, res, next) => {
  try {
    const r = verify(req.body.loop_id, req.body.anon_user_id, req.body.response);
    res.json(ok(r));
  } catch (e) {
    next(e);
  }
});

export default router;
