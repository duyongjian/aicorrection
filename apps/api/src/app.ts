/**
 * Express 装配（路由 / 中间件 / 静态托管）
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from './config/env';

// ESM 下 __dirname 不存在，以 import.meta.url 推导
const __dirname = path.dirname(fileURLToPath(import.meta.url));

import accountRoutes from './routes/accountRoutes';
import uploadRoutes from './routes/uploadRoutes';
import attributionRoutes from './routes/attributionRoutes';
import rateRoutes from './routes/rateRoutes';
import followupRoutes from './routes/followupRoutes';
import reviewRoutes from './routes/reviewRoutes';
import trackingRoutes from './routes/trackingRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  if (env.NODE_ENV !== 'test') app.use(morgan('dev'));
  app.use(express.json({ limit: '15mb' }));

  const base = env.API_BASE_PATH;

  app.get('/health', (_req, res) => {
    res.json({ ok: true, base, provider: env.LLM_PROVIDER });
  });

  app.use(`${base}/account`, accountRoutes);
  app.use(`${base}/upload`, uploadRoutes);
  app.use(`${base}/attribution`, attributionRoutes);
  // rate / followup 为 /attribution/:loop_id/... 子路径，挂在 base 下
  app.use(`${base}`, rateRoutes);
  app.use(`${base}`, followupRoutes);
  app.use(`${base}/review`, reviewRoutes);
  app.use(`${base}/track`, trackingRoutes);
  app.use(`${base}/dashboard`, dashboardRoutes);

  // 生产态：托管前端静态资源（SPA 回退，排除 /api 避免吞掉未知 API 404）
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
