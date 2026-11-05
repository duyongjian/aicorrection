/**
 * 看板路由（QAL-02）
 * GET /api/v1/dashboard/m1?window_days=14
 * GET /api/v1/dashboard/upload-failures?window_days=14 （v0.1.x 诊断，非 G1 口径）
 */
import { Router } from 'express';
import { z } from 'zod';
import { computeM1, computeUploadFailureBreakdown } from '../services/dashboardService';
import { ok } from '../utils/result';

const router = Router();

function parseWindowDays(raw: unknown): number {
  return z.coerce.number().int().positive().max(365).default(14).parse(raw);
}

router.get('/m1', (req, res, next) => {
  try {
    const stats = computeM1(parseWindowDays(req.query.window_days));
    res.json(ok(stats));
  } catch (e) {
    next(e);
  }
});

router.get('/upload-failures', (req, res, next) => {
  try {
    const stats = computeUploadFailureBreakdown(parseWindowDays(req.query.window_days));
    res.json(ok(stats));
  } catch (e) {
    next(e);
  }
});

export default router;
