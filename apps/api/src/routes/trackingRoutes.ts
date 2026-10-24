/**
 * 埋点接收路由（INF-03）
 * POST /api/v1/track —— 批量接收，服务端仅落库 + 幂等去重，不主动发事件。
 */
import { Router } from 'express';
import { z } from 'zod';
import { ingest } from '../services/tracking/trackingService';
import { ok } from '../utils/result';
import type { TrackEvent } from '@aicorrection/shared';

const router = Router();

const eventSchema = z.object({
  event_name: z.string().min(1),
  context: z.record(z.unknown()),
  props: z.record(z.unknown()).default({}),
  ts_utc: z.string().min(1),
});

const schema = z.object({
  events: z.array(eventSchema).min(1),
});

router.post('/', (req, res, next) => {
  try {
    const parsed = schema.parse(req.body);
    const result = ingest(parsed.events as unknown as TrackEvent[]);
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

export default router;
