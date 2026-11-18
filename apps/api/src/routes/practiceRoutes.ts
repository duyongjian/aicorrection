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
  sedimentAnswer,
  generateTargetedGroup,
} from '../services/learningService';
import {
  getCauseAggregation,
  getWeakPoints,
  refreshAllMastery,
  getMasteryState,
} from '../services/aggregationService';
import {
  getDueReviewsList,
  createReview,
  completeReview,
} from '../services/reviewScheduleService';
import {
  createCustomKp,
  listCustomKps,
  setManualCause,
  getKnowledgeGraph,
  getKpMistakes,
} from '../services/knowledgeService';
import { ERROR_CODES } from '@aicorrection/shared';
import { HttpError } from '../middleware/errorHandler';
import { requireEntitlement } from '../middleware/requireLicense';

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

// ===================== P1 强化期 =====================

/** 查询参数中提取并校验 anon_user_id。 */
function requireAnonUserId(req: { query: Record<string, unknown> }): string {
  const v = req.query.anon_user_id;
  if (typeof v !== 'string' || !v.trim()) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '缺少 anon_user_id');
  }
  return v.trim();
}

/** R09 错因聚合：按 cause_id 统计分布。 */
router.get('/aggregate/causes', (req, res, next) => {
  try {
    const anon_user_id = requireAnonUserId(req);
    res.json(ok(getCauseAggregation(anon_user_id)));
  } catch (e) {
    next(e);
  }
});

/** R10 薄弱点可视化：按知识点合并错误数/练习数/掌握等级/主要错因。 */
router.get('/weak-points', (req, res, next) => {
  try {
    const anon_user_id = requireAnonUserId(req);
    res.json(ok(getWeakPoints(anon_user_id)));
  } catch (e) {
    next(e);
  }
});

/** R14 掌握度：重算并返回该用户全部知识点掌握状态。 */
router.get('/mastery', (req, res, next) => {
  try {
    const anon_user_id = requireAnonUserId(req);
    res.json(ok(refreshAllMastery(anon_user_id)));
  } catch (e) {
    next(e);
  }
});

/** R14 掌握度：单个知识点（kp_key 可能含 'txt:' 前缀，URL 编码传入）。 */
router.get('/mastery/:kp_key', (req, res, next) => {
  try {
    const anon_user_id = requireAnonUserId(req);
    const kpKey = decodeURIComponent(req.params.kp_key || '');
    if (!kpKey) throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '缺少 kp_key');
    res.json(ok(getMasteryState(anon_user_id, kpKey)));
  } catch (e) {
    next(e);
  }
});

/** R11 答案沉淀：把认可的题目+解析沉淀进题库（UGC 待审）。 */
router.post(
  '/sediment',
  validateBody(
    z.object({
      anon_user_id: z.string().min(1),
      loop_id: z.string().min(1).nullable().optional(),
      question: z.string().min(2),
      answer: z.string().min(1),
      knowledge_point: z.string().nullable().optional(),
      snippet: z.string().nullable().optional(),
      subject: z.string().nullable().optional(),
    })
  ),
  (req, res, next) => {
    (async () => {
      try {
        const r = await sedimentAnswer(req.body);
        res.json(ok(r));
      } catch (e) {
        next(e);
      }
    })();
  }
);

/** R13 针对性多题练习：针对薄弱知识点生成题组。 */
router.post(
  '/practice/generate-group',
  validateBody(
    z.object({
      anon_user_id: z.string().min(1),
      target_kp: z.string().min(1),
      count: z.number().int().min(1).max(20),
      kp_key: z.string().nullable().optional(),
    })
  ),
  (req, res, next) => {
    try {
      const r = generateTargetedGroup(req.body);
      res.json(ok(r));
    } catch (e) {
      next(e);
    }
  }
);

// ===================== P2 间隔复习（R15/R16 复习列表 + R12 变式题） =====================

/** R16 复习列表：该用户全部复习计划（含 is_due 标记）。需要 spaced_review 权益。 */
router.get('/review/due', requireEntitlement('spaced_review'), (req, res, next) => {
  try {
    const anon_user_id = requireAnonUserId(req);
    res.json(ok(getDueReviewsList(anon_user_id)));
  } catch (e) {
    next(e);
  }
});

/** R15 发起一次复测：返回变式题（is_variant=1）。 */
router.post(
  '/review/start',
  requireEntitlement('spaced_review'),
  validateBody(
    z.object({
      anon_user_id: z.string().min(1),
      kp_key: z.string().min(1),
      kp_text: z.string().nullable().optional(),
      source_loop_id: z.string().nullable().optional(),
    })
  ),
  (req, res, next) => {
    try {
      const r = createReview(
        req.body.anon_user_id,
        req.body.kp_key,
        req.body.kp_text ?? null,
        req.body.source_loop_id ?? null
      );
      res.json(ok(r));
    } catch (e) {
      next(e);
    }
  }
);

/** R15 完成复测：写回流结果并刷新复习间隔。 */
router.post(
  '/review/complete',
  requireEntitlement('spaced_review'),
  validateBody(
    z.object({
      review_id: z.string().min(1),
      retest_result: z.enum(['correct', 'wrong', 'skip']),
    })
  ),
  (req, res, next) => {
    try {
      const r = completeReview(req.body.review_id, req.body.retest_result);
      res.json(ok(r));
    } catch (e) {
      next(e);
    }
  }
);

// ===================== P2 自定义知识点 / 手动错因 / 知识图谱（R17/R20/R18） =====================

/** R17 自定义知识点：新增（kp_id 自动以 ckp_ 前缀生成）。需要 custom_kp 权益。 */
router.post(
  '/custom-kp',
  requireEntitlement('custom_kp'),
  validateBody(
    z.object({
      anon_user_id: z.string().min(1),
      kp_text: z.string().min(1),
      parent_kp_key: z.string().nullable().optional(),
    })
  ),
  (req, res, next) => {
    try {
      const r = createCustomKp(req.body);
      res.json(ok(r));
    } catch (e) {
      next(e);
    }
  }
);

/** R17 自定义知识点：列出该用户的全部自定义知识点。需要 custom_kp 权益。 */
router.get('/custom-kp', requireEntitlement('custom_kp'), (req, res, next) => {
  try {
    const anon_user_id = requireAnonUserId(req);
    res.json(ok(listCustomKps(anon_user_id)));
  } catch (e) {
    next(e);
  }
});

/** R20 手动错因：覆盖 AI 判定的 cause / knowledge_point。 */
router.patch(
  '/attribution/:loop_id/cause',
  validateBody(
    z.object({
      anon_user_id: z.string().min(1),
      cause_id: z.string().nullable().optional(),
      knowledge_point: z.string().nullable().optional(),
      knowledge_point_id: z.string().nullable().optional(),
    })
  ),
  (req, res, next) => {
    try {
      const r = setManualCause({
        loop_id: req.params.loop_id,
        anon_user_id: req.body.anon_user_id,
        cause_id: req.body.cause_id,
        knowledge_point: req.body.knowledge_point,
        knowledge_point_id: req.body.knowledge_point_id,
      });
      res.json(ok(r));
    } catch (e) {
      next(e);
    }
  }
);

/**
 * R18 图谱下钻：按知识点列出该用户的错题。需要 knowledge_graph 权益。
 * 放在 /graph 之前更符合路径特例优先的直觉；Express 精确匹配下二者互不干扰。
 */
router.get('/graph/mistakes', requireEntitlement('knowledge_graph'), (req, res, next) => {
  try {
    const anon_user_id = requireAnonUserId(req);
    const kpKey = req.query.kp_key;
    if (typeof kpKey !== 'string' || !kpKey.trim()) {
      throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, '缺少 kp_key');
    }
    res.json(ok(getKpMistakes(anon_user_id, kpKey)));
  } catch (e) {
    next(e);
  }
});

/** R18 知识图谱：导出该用户的知识点共现图（节点 + 边）。需要 knowledge_graph 权益。 */
router.get('/graph', requireEntitlement('knowledge_graph'), (req, res, next) => {
  try {
    const anon_user_id = requireAnonUserId(req);
    res.json(ok(getKnowledgeGraph(anon_user_id)));
  } catch (e) {
    next(e);
  }
});

export default router;
