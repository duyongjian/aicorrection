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
import licenseRoutes from './routes/licenseRoutes';
import authRoutes from './routes/authRoutes';
import learnRoutes from './routes/practiceRoutes';
import { requireLicense } from './middleware/requireLicense';
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
    const analysisIsSeparate =
      env.ANALYSIS_BASE_URL !== env.LLM_BASE_URL ||
      env.ANALYSIS_MODEL !== env.LLM_MODEL;

    // ---- 生效值回显 + 配置体检 ----
    // 背景：dotenv 下 .env 的显式值优先级高于代码默认值。曾出现 .env 里仍写着旧的
    // 45s/30s，强模型必然超时并静默走诚实降级 analyzing —— 不报错、难排查。
    // 这里把实际生效值原样回显，并对明显不足的超时给出显式告警。
    const RECOMMENDED_ATTRIBUTION_TIMEOUT_MS = 180_000;
    const RECOMMENDED_FOLLOWUP_TIMEOUT_MS = 120_000;
    const warnings: string[] = [];
    if (env.ATTRIBUTION_TIMEOUT_MS < RECOMMENDED_ATTRIBUTION_TIMEOUT_MS) {
      warnings.push(
        'ATTRIBUTION_TIMEOUT_MS 当前生效 ' + env.ATTRIBUTION_TIMEOUT_MS +
        'ms，低于建议下限 ' + RECOMMENDED_ATTRIBUTION_TIMEOUT_MS +
        'ms。本机 Qwen3.8-27B 归因实测区间 60s~161s，超时不会报错而是静默走诚实降级 analyzing。' +
        '请在 apps/api/.env 改为 ATTRIBUTION_TIMEOUT_MS=300000（或删除该行以回落代码默认值）。'
      );
    }
    if (env.FOLLOWUP_TIMEOUT_MS < RECOMMENDED_FOLLOWUP_TIMEOUT_MS) {
      warnings.push(
        'FOLLOWUP_TIMEOUT_MS 当前生效 ' + env.FOLLOWUP_TIMEOUT_MS +
        'ms，低于建议下限 ' + RECOMMENDED_FOLLOWUP_TIMEOUT_MS +
        'ms。追问走同一强模型，建议值 180000。'
      );
    }
    if (analysisIsSeparate && !analysisAvailable) {
      warnings.push(
        '分析强模型不可达：' + env.ANALYSIS_BASE_URL + ' 模型 ' + env.ANALYSIS_MODEL +
        '。归因会走诚实降级 analyzing，按无 Mock 策略不会产出假数据。'
      );
    }
    if (analysisIsSeparate && !env.DISABLE_THINKING) {
      warnings.push(
        'DISABLE_THINKING 未开启：分析强模型保留思考链时单次归因实测约 266s，关闭后约 161s，建议设为 true。'
      );
    }

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
        isSeparate: analysisIsSeparate,
        isAvailable: analysisAvailable,
        models: analysisModels,
      },
      // ---- 本次新增：实际生效值回显（用于排查 .env 静默覆盖） ----
      effective: {
        ATTRIBUTION_TIMEOUT_MS: env.ATTRIBUTION_TIMEOUT_MS,
        FOLLOWUP_TIMEOUT_MS: env.FOLLOWUP_TIMEOUT_MS,
        DISABLE_THINKING: env.DISABLE_THINKING,
        AUTO_FALLBACK_TO_MOCK: env.AUTO_FALLBACK_TO_MOCK,
        ANALYSIS_BASE_URL: env.ANALYSIS_BASE_URL,
        ANALYSIS_MODEL: env.ANALYSIS_MODEL,
        ANALYSIS_API_KEY_SET: Boolean(env.ANALYSIS_API_KEY),
      },
      // 配置体检：命中即说明当前配置跑强模型必然降级，附具体处置方法
      warnings,
    });
  });

  // ---- 线下分发 MVP：卡密门禁 ----
  // 挂载在 base 上、所有业务路由之前。此时 req.path 已被剥掉 base 前缀，
  // 与 requireLicense 的 PUBLIC_RULES 相对路径一致。
  // 门禁默认关闭（LICENSE_GATE_ENABLED=true 才生效），既有开发/单测行为零变化。
  // /health 在 base 之外、/config/llm-status 在上面已注册，两者天然放行。
  // 静态前端托管在 base 之外，未激活用户始终能打开激活页。
  app.use(base, requireLicense);
  app.use(`${base}/license`, licenseRoutes);
  app.use(`${base}/auth`, authRoutes);
  app.use(`${base}/learn`, learnRoutes);

  app.use(`${base}/account`, accountRoutes);
  app.use(`${base}/upload`, uploadRoutes);

  // 上传原图只读静态服务（供前端回显）。仅暴露 uploads 目录，禁止目录列表与点文件。
  // 注：不要设 fallthrough:false —— express.static 在文件缺失时抛 404 Error，
  // 而本项目的 errorHandler 只识别 HttpError，其余一律转 500，会把"图片不存在"
  // 误报为服务内部错误。保持默认 fallthrough，让未命中落到 notFoundHandler 返回 404。
  app.use(
    `${base}/uploads`,
    express.static(env.UPLOAD_DIR, {
      index: false,
      dotfiles: 'deny',
      maxAge: '1h',
    })
  );

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
