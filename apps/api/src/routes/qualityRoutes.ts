/**
 * 质量优化路由（G1 闸门 / B·C·D 分层 / 代理↔质量校准）。
 * 这些端点为运营/质量看板与内部评估服务，挂在学习/仪表盘之后，默认受门禁保护。
 */
import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../utils/result';
import { validateBody } from '../middleware/validate';
import {
  evaluateQualityGate,
  computeStrataReport,
  calibrateQuality,
} from '../services/qualityGateService';

const router = Router();

/** G1 质量闸门：聚合 M1/闭环健康/盲评覆盖，给出可发布判定。 */
router.get('/gate', (req, res) => {
  const windowDays = Number(req.query.windowDays) || 14;
  res.json(ok(evaluateQualityGate(windowDays)));
});

/** B·C·D 分层报告：各知识点分层与各层盲评覆盖。 */
router.get('/strata', (_req, res) => {
  res.json(ok(computeStrataReport()));
});

/** 代理↔质量校准：代理自报分按置信度收敛到先验，输出保守校准分。 */
router.post(
  '/calibrate',
  validateBody(
    z.object({
      raw_score: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1),
    })
  ),
  (req, res, next) => {
    try {
      res.json(ok(calibrateQuality(req.body)));
    } catch (e) {
      next(e);
    }
  }
);

export default router;
