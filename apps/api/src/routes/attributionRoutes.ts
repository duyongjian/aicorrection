/**
 * 归因路由（ATT-02）
 * 降级态（analyzing / incomplete）以 HTTP 200 + data.status 表达（前后端一致）。
 */
import { Router } from 'express';
import { z } from 'zod';
import { generateAttribution } from '../services/attribution/attributionService';
import { ok } from '../utils/result';
import { validateBody } from '../middleware/validate';

const router = Router();

const schema = z.object({
  loop_id: z.string().min(1),
  anon_user_id: z.string().min(1),
  question: z.string().min(1),
  user_answer: z.string().optional(),
  // 学科标签：透传给归因服务，用于知识锚点（如英文分词题）的语境门控。
  subject: z.string().optional(),
});

router.post('/', validateBody(schema), async (req, res, next) => {
  try {
    const data = await generateAttribution({
      ...req.body,
      is_internal: req.is_internal ?? false,
    });
    res.json(ok(data));
  } catch (e) {
    next(e);
  }
});

export default router;
