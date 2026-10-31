/**
 * 题库 RAG 检索服务（P1）
 *
 * 职责：把"学生题干"嵌入 → 向量库 top-k → 低于阈值判空 → 组装 AttributionReference。
 * 硬约束（产品/任务）：
 *  - 任何异常（嵌入失败 / DB 异常）都必须返回 status='unavailable' 且 items=[]，
 *    绝不抛错、绝不虚构参考内容；归因流程会照常继续。
 *  - RAG_ENABLED=false 时直接返回空（不触达嵌入/DB）。
 *  - 空结果 status='empty'（items=[]），与 unavailable 区分（便于前端/埋点区分"无相关"与"检索挂了"）。
 */
import { env } from '../../config/env';
import { embed } from './embeddingService';
import { getItem, query } from './vectorStore';
import { roundTo } from '../../utils/math';
import type {
  AttributionReference,
  AttributionReferenceItem,
} from '@aicorrection/shared';

/** 参考片段截断长度（字符）。 */
const SNIPPET_MAX = 240;

function truncate(text: string, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export interface RetrieveOptions {
  /** 学科过滤（与题库 subject 对齐） */
  subject?: string;
  /** 覆盖 RAG_TOP_K */
  topK?: number;
  /** 覆盖 RAG_MIN_SCORE */
  minScore?: number;
}

/**
 * 检索与"题干"相关的题库参考项。
 * 返回 AttributionReference（ok/empty/unavailable）。本函数自身不抛错。
 */
export async function retrieveReferences(
  question: string,
  opts: RetrieveOptions = {}
): Promise<AttributionReference> {
  // 关闭开关：直接空（不触达嵌入/DB），归因流程零影响。
  if (!env.RAG_ENABLED) {
    return { status: 'empty', source: 'qbank', items: [] };
  }

  try {
    const vec = embed(question);
    const k = opts.topK ?? env.RAG_TOP_K;
    const minScore = opts.minScore ?? env.RAG_MIN_SCORE;

    const scored = query(vec, k, { subject: opts.subject });

    const items: AttributionReferenceItem[] = [];
    for (const s of scored) {
      if (s.score < minScore) continue; // 低于阈值：视为不相关，丢弃
      const it = getItem(s.item_id);
      if (!it) continue;
      items.push({
        item_id: it.item_id,
        title: it.knowledge_point,
        snippet: truncate(it.answer_text || it.solution_steps || '', SNIPPET_MAX),
        knowledge_point: it.knowledge_point,
        score: roundTo(s.score, 4),
      });
    }

    return {
      status: items.length > 0 ? 'ok' : 'empty',
      source: 'qbank',
      items,
    };
  } catch {
    // 失败绝不抛错 / 绝不虚构：仅跳过参考块。
    return { status: 'unavailable', source: 'qbank', items: [] };
  }
}
