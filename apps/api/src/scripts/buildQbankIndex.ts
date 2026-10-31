/**
 * 题库向量索引脚本（P1）
 *
 * 取 embedding_status<>'done' 或 vec 为空的题库项 → 离线嵌入 → 写回向量并置 status='done'。
 * 可断点续跑：已 'done' 的项会被跳过，重复执行只补建新增/失败项。
 *
 * embed 现支持 local-hash（默认）/ bge（本地 onnx）两种方案，由 RAG_EMBED_MODEL 切换。
 * 切到 bge（1024 维）后首次运行本脚本即重建全部向量；旧 384 维向量需重跑本脚本覆盖。
 *
 * 用法：
 *   tsx src/scripts/buildQbankIndex.ts
 */
import { getDb } from '../db';
import { getAllQbankForEmbedding } from '../models/qbankModel';
import { embed, embedItemSource } from '../services/rag/embeddingService';
import { upsertVec } from '../services/rag/vectorStore';
import { env } from '../config/env';

async function main(): Promise<void> {
  // 触发迁移，确保表与列存在
  const db = getDb();
  // 批量重建优化：关闭逐提交 fsync（WAL + synchronous=OFF），避免大批量
  // 向量回写被同步写阻塞；本题库为本地可重跑重建，若中途崩溃可安全重跑续建。
  db.pragma('synchronous = OFF');

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
      const vec = await embed(embedItemSource(item));
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

main().catch((e) => {
  console.error(`[buildQbankIndex] 失败：${(e as Error).message}`);
  process.exit(1);
});
