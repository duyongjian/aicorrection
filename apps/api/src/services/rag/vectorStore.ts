/**
 * 纯 SQLite 向量存储（P1 题库 RAG）
 *
 * 不引入 sqlite-vec / lancedb：向量以 JSON 数组存于 qbank_items.embedding_vec 列，
 * 由本模块在 Node 侧做余弦相似度 top-k。数据量（种子级 ~ 数百条）下完全够用。
 */
import { env } from '../../config/env';
import { cosineSimilarity } from '../../utils/math';
import {
  getQbankById,
  queryQbankBySubject,
  updateEmbedding,
} from '../../models/qbankModel';

export interface ScoredItem {
  item_id: string;
  score: number;
}

/**
 * 写入/覆盖一条向量的"已索引"状态。
 * 直接复用 qbankModel.updateEmbedding（落 vec + 置 status='done' + 记录 model）。
 */
export function upsertVec(item_id: string, vec: number[]): void {
  updateEmbedding(item_id, vec, env.RAG_EMBED_MODEL);
}

/**
 * 余弦 top-k 检索。
 * @param vec      查询向量（已 L2 归一化）
 * @param k        返回条数（默认 4）
 * @param filter   可选学科过滤（subject）
 * @returns        按相似度降序的命中列表（不含自身向量解析失败的脏数据）
 */
export function query(vec: number[], k: number = 4, filter?: { subject?: string }): ScoredItem[] {
  const items = queryQbankBySubject(filter?.subject);
  const scored: ScoredItem[] = [];
  for (const it of items) {
    if (!it.embedding_vec) continue;
    let emb: number[];
    try {
      emb = JSON.parse(it.embedding_vec) as number[];
    } catch {
      continue; // 脏数据：跳过，不阻塞整体检索
    }
    if (!Array.isArray(emb) || emb.length === 0) continue;
    scored.push({ item_id: it.item_id, score: cosineSimilarity(vec, emb) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, k));
}

/** 取单条用于回填参考块展示。 */
export function getItem(item_id: string) {
  return getQbankById(item_id);
}
