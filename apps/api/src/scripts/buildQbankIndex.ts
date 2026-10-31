/**
 * 题库向量索引脚本（P1）
 *
 * 取 embedding_status<>'done' 或 vec 为空的题库项 → 离线嵌入 → 写回向量并置 status='done'。
 * 可断点续跑：已 'done' 的项会被跳过，重复执行只补建新增/失败项。
 *
 * 用法：
 *   tsx src/scripts/buildQbankIndex.ts
 */
import { getDb } from '../db';
import { getAllQbankForEmbedding } from '../models/qbankModel';
import { embed, embedItemSource } from '../services/rag/embeddingService';
import { upsertVec } from '../services/rag/vectorStore';
import { env } from '../config/env';

function main(): void {
  // 触发迁移，确保表与列存在
  getDb();

  const pending = getAllQbankForEmbedding();
  if (pending.length === 0) {
    console.log('[buildQbankIndex] 没有待嵌入的题库项，索引已是最新。');
    return;
  }

  console.log(
    `[buildQbankIndex] 待嵌入 ${pending.length} 条（embedding_model=${env.RAG_EMBED_MODEL}）...`
  );
  let done = 0;
  let skipped = 0;
  for (const item of pending) {
    try {
      const vec = embed(embedItemSource(item));
      upsertVec(item.item_id, vec); // 落 vec + 置 status='done' + 记录 model
      done++;
    } catch (e) {
      // 单条失败不中断整体；留作下次续跑（status 仍为 pending）。
      skipped++;
      console.warn(`[buildQbankIndex] 跳过 ${item.item_id}：${(e as Error).message}`);
    }
  }
  console.log(
    `[buildQbankIndex] 完成：本次为 ${done} 条建立向量索引${skipped ? `，${skipped} 条失败留待续跑` : ''}。`
  );
}

main();
