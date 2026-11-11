/**
 * 管理后台 API（受 x-admin-key 保护）
 *
 * 解决「有些必要的东西允许在管理后台修改」的需求——把原本散落在 env.ts / _seedRag.ts 里、需要改代码才能调的旋钮，
 * 收拢成可运行时操作的 HTTP 接口：
 *  - GET  /config            查看当前生效配置（runtimeSettings 覆盖优先，否则回落 env）
 *  - PUT  /config            运行时覆盖配置（白名单键，持久化到本地 SQLite settings 表，不回写 .env）
 *  - GET  /qbank             列表/搜索知识点库（?subject=&q=&limit=）
 *  - POST /qbank             新增知识点（自动建索引）
 *  - GET  /qbank/:id         查看单条
 *  - PUT  /qbank/:id         更新（文本变更自动重建索引）
 *  - DELETE /qbank/:id       删除
 *  - POST /qbank/reindex     重建全部 pending 向量索引
 *  - POST /attribution/test  归因调试台：贴一道题跑归因，回显结果与命中的 RAG 知识点
 *
 * 全部本地、零外发，符合数据主权铁律。
 */
import { Router, type Request, type Response, type RequestHandler } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/errorHandler';
import { ERROR_CODES } from '@aicorrection/shared';
import * as rt from '../services/admin/runtimeSettings';
import {
  insertQbankItem,
  getQbankById,
  listQbank,
  deleteQbankItem,
  reindexItem,
  updateEmbedding,
  type QbankUpsert,
} from '../models/qbankModel';
import { embed, embedItemSource } from '../services/rag/embeddingService';
import { buildQbankIndex } from '../scripts/buildQbankIndex';
import { retrieveReferences } from '../services/rag/ragService';
import { generateAttribution } from '../services/attribution/attributionService';
import { generateAttributionId } from '../utils/id';
import { env } from '../config/env';

const router = Router();

/** async 路由错误捕获：统一交给 errorHandler（输出 {code,message} 信封）。 */
function ah(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** zod 解析失败 → 400（而非 500），信息友好。 */
function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown, label: string): T {
  try {
    return schema.parse(body);
  } catch (e) {
    throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, `${label} 校验失败：${(e as Error).message}`);
  }
}

const ItemSchema = z.object({
  item_id: z.string().min(1).optional(),
  subject: z.string().min(1),
  question_text: z.string().min(1),
  answer_text: z.string().min(1),
  knowledge_point: z.string().min(1),
  solution_steps: z.string().nullable().optional(),
  grade_level: z.string().nullable().optional(),
  difficulty: z.number().int().nullable().optional(),
  source: z.string().nullable().optional(),
  license: z.string().nullable().optional(),
  cause_tags_json: z.string().nullable().optional(),
});

// ── 配置查看 / 修改 ──────────────────────────────────────────────
router.get(
  '/config',
  ah(async (_req, res) => {
    res.json({ ok: true, config: rt.configView() });
  })
);

// 仅允许白名单键；值统一转字符串持久化。
const ConfigPatch = z.record(z.unknown());
router.put(
  '/config',
  ah(async (req, res) => {
    const body = parseOrThrow(ConfigPatch, req.body ?? {}, 'config');
    const updated: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!(rt.MANAGED_KEYS as readonly string[]).includes(k)) {
        throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, `不可通过后台修改的配置键：${k}`);
      }
      const str = String(v);
      rt.setRaw(k, str);
      updated[k] = str;
    }
    res.json({ ok: true, updated, config: rt.configView() });
  })
);

// 清除单条覆盖（恢复回落 env 默认值）。键同样须白名单。
router.delete(
  '/config/:key',
  ah(async (req, res) => {
    const k = req.params.key;
    if (!(rt.MANAGED_KEYS as readonly string[]).includes(k)) {
      throw new HttpError(ERROR_CODES.PARAM_INVALID, 400, `不可通过后台修改/清除的配置键：${k}`);
    }
    rt.deleteRaw(k);
    res.json({ ok: true, cleared: k, config: rt.configView() });
  })
);

// ── 知识点库 CRUD ────────────────────────────────────────────────
router.get(
  '/qbank',
  ah(async (req, res) => {
    const subject = typeof req.query.subject === 'string' ? req.query.subject : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    res.json({ ok: true, items: listQbank({ subject, q, limit }) });
  })
);

router.post(
  '/qbank',
  ah(async (req, res) => {
    const data = parseOrThrow(ItemSchema, req.body ?? {}, 'qbank 项');
    const item_id = data.item_id || `kb-${generateAttributionId()}`;
    const row: QbankUpsert = { ...data, item_id };
    insertQbankItem(row);
    const item = getQbankById(item_id);
    let indexed = false;
    if (item) {
      const vec = await embed(embedItemSource(item));
      updateEmbedding(item_id, vec, env.RAG_EMBED_MODEL);
      indexed = true;
    }
    res.json({ ok: true, item_id, indexed, item: getQbankById(item_id) });
  })
);

router.get(
  '/qbank/:id',
  ah(async (req, res) => {
    const it = getQbankById(req.params.id);
    if (!it) throw new HttpError(ERROR_CODES.NOT_FOUND, 404, '知识点不存在');
    res.json({ ok: true, item: it });
  })
);

router.put(
  '/qbank/:id',
  ah(async (req, res) => {
    const existing = getQbankById(req.params.id);
    if (!existing) throw new HttpError(ERROR_CODES.NOT_FOUND, 404, '知识点不存在');
    const data = parseOrThrow(ItemSchema, req.body ?? {}, 'qbank 项');
    // INSERT OR REPLACE：覆盖同 item_id
    insertQbankItem({ ...data, item_id: req.params.id });
    const reindexed = await reindexItem(req.params.id);
    res.json({ ok: true, item_id: req.params.id, reindexed, item: getQbankById(req.params.id) });
  })
);

router.delete(
  '/qbank/:id',
  ah(async (req, res) => {
    const existing = getQbankById(req.params.id);
    if (!existing) throw new HttpError(ERROR_CODES.NOT_FOUND, 404, '知识点不存在');
    deleteQbankItem(req.params.id);
    res.json({ ok: true, deleted: req.params.id });
  })
);

router.post(
  '/qbank/reindex',
  ah(async (_req, res) => {
    await buildQbankIndex();
    res.json({ ok: true, message: 'reindex 完成（见服务端日志获取条数）' });
  })
);

// ── 归因调试台 ───────────────────────────────────────────────────
const TestSchema = z.object({
  question: z.string().min(1),
  user_answer: z.string().optional(),
  subject: z.string().optional(),
});
router.post(
  '/attribution/test',
  ah(async (req, res) => {
    const body = parseOrThrow(TestSchema, req.body ?? {}, 'attribution test');
    // 跑一次真实归因（沿用当前生效策略：single/ensemble/cloud），is_internal 标内部调用
    const result = await generateAttribution({
      loop_id: `admin-test-${generateAttributionId()}`,
      anon_user_id: 'admin-test-console',
      question: body.question,
      user_answer: body.user_answer,
      subject: body.subject,
      is_internal: true,
    });
    // 另取强制 RAG 命中（force 模式，绕过全局 RAG 闸门），直观展示"事实 specialist 会补什么"
    const ragHits = await retrieveReferences(body.question, {
      subject: body.subject,
      force: true,
      topK: env.RAG_TOP_K,
    }).catch(() => ({ status: 'unavailable', source: 'qbank', items: [] }));
    res.json({ ok: true, result, ragHits });
  })
);

export default router;
