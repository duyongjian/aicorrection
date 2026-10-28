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
import { metadataMiddleware } from './middleware/metadata';

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
import { getAnalysisProvider, getRecognitionProvider } from './services/llm';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  if (env.NODE_ENV !== 'test') app.use(morgan('dev'));
  app.use(express.json({ limit: '15mb' }));
  // T4: metadata 中间件 — 注入 is_internal / channel / utm 到每个请求
  app.use(metadataMiddleware);

  const base = env.API_BASE_PATH;

  app.get('/health', (_req, res) => {
    res.json({ ok: true, base, provider: env.LLM_PROVIDER });
  });

  // 只读状态接口：确认 AI 接入接线（provider / 模型 id / 可达性），不改动任何配置。
  // 用途：改完 .env 后，无需重启就能看到当前生效的 LLM 配置与本地模型是否在线。
  // 两段接线：recognition=题目识别/视觉（LLM_* / VISION_*），analysis=归因/追问（ANALYSIS_*）。
  // ANALYSIS_* 未配置时两者指向同一端点，便于改完 .env 后无需重启即可核对是否生效。
  app.get(`${base}/config/llm-status`, async (_req, res) => {
    const provider = getRecognitionProvider();
    const analysis = getAnalysisProvider();
    const [isAvailable, models, analysisAvailable, analysisModels] = await Promise.all([
      provider.isAvailable().catch(() => false),
      provider.listModels().catch(() => []),
      analysis.isAvailable().catch(() => false),
      analysis.listModels().catch(() => []),
    ]);
    res.json({
      // ---- 原有顶层字段：保留以免破坏既有调用方 ----
      provider: env.LLM_PROVIDER,
      providerName: provider.name,
      baseUrl: env.LLM_BASE_URL,
      textModel: env.LLM_MODEL,
      visionModel: env.VISION_MODEL,
      autoFallbackToMock: env.AUTO_FALLBACK_TO_MOCK,
      isAvailable,
      models,
      // ---- 新增：识别 / 分析 两段分别报告 ----
      recognition: {
        providerName: provider.name,
        baseUrl: env.LLM_BASE_URL,
        textModel: env.LLM_MODEL,
        visionModel: env.VISION_MODEL,
        isAvailable,
        models,
      },
      analysis: {
        providerName: analysis.name,
        baseUrl: env.ANALYSIS_BASE_URL,
        model: env.ANALYSIS_MODEL,
        // 是否真的与识别端分家（ANALYSIS_* 与 LLM_* 不同即为 true）
        isSeparate:
          env.ANALYSIS_BASE_URL !== env.LLM_BASE_URL ||
          env.ANALYSIS_MODEL !== env.LLM_MODEL,
        isAvailable: analysisAvailable,
        models: analysisModels,
      },
    });
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
