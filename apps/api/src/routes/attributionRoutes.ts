/**
 * 归因路由（ATT-02）
 * 降级态（analyzing / incomplete）以 HTTP 200 + data.status 表达（前后端一致）。
 */
import { Router } from 'express';
import { z } from 'zod';
import { generateAttribution } from '../services/attribution/attributionOrchestrator';
import { listAttributionsByUser } from '../models/attributionModel';
import { getLoopDetail } from '../models/loopDetailModel';
import { HttpError } from '../middleware/errorHandler';
import { ok } from '../utils/result';
import { validateBody } from '../middleware/validate';
import { ERROR_CODES } from '@aicorrection/shared';

const router = Router();

/**
 * 归因历史列表（FLW-02）：按用户列出最近归因，含关联原图 URL。
 * 不依赖内存态，跨会话可查；anon_user_id 缺失时返回空列表。
 */
router.get('/history', (req, res, next) => {
  try {
    const anon_user_id = String(req.query.anon_user_id ?? '').trim();
    if (!anon_user_id) {
      res.json(ok([]));
      return;
    }
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(200, Math.max(1, Math.floor(limitRaw) || 50))
      : 50;
    const data = listAttributionsByUser(anon_user_id, limit);
    res.json(ok(data));
  } catch (e) {
    next(e);
  }
});

const schema = z.object({
  loop_id: z.string().min(1),
  anon_user_id: z.string().min(1),
  question: z.string().min(1),
  user_answer: z.string().optional(),
  // 学科标签：透传给归因服务，用于知识锚点（如英文分词题）的语境门控。
  subject: z.string().optional(),
  // 联网搜索：默认不传（关闭）；前端开关显式开启时传 true，逐次确认外发脱敏题干。
  web_search: z.boolean().optional(),
});

router.post('/', validateBody(schema), async (req, res, next) => {
  try {
    const data = await generateAttribution({
      loop_id: req.body.loop_id,
      anon_user_id: req.body.anon_user_id,
      question: req.body.question,
      user_answer: req.body.user_answer,
      subject: req.body.subject,
      is_internal: req.is_internal ?? false,
      enableWebSearch: req.body.web_search ?? false,
    });
    res.json(ok(data));
  } catch (e) {
    next(e);
  }
});

/**
 * 闭环回看详情（FLW-02 增强）：归因 + 追问 + 练习 + 复盘，按 loop 可回顾。
 * anon_user_id 作二次校验（与 loop_sessions 比对），不匹配返回 404。
 */
router.get('/:loop_id/detail', (req, res, next) => {
  try {
    const loop_id = String(req.params.loop_id ?? '').trim();
    const anon_user_id = String(req.query.anon_user_id ?? '').trim();
    if (!loop_id || !anon_user_id) {
      throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, 'loop_id 与 anon_user_id 必填');
    }
    const detail = getLoopDetail(loop_id, anon_user_id);
    if (!detail) {
      throw new HttpError(ERROR_CODES.NOT_FOUND, 404, '未找到该闭环记录');
    }
    res.json(ok(detail));
  } catch (e) {
    next(e);
  }
});

export default router;
