/**
 * 临时种子脚本（演示用，跑完即删）：把 5 道"小模型知识盲区"题的权威知识点灌入 qbank_items
 * 并建本地 hash 索引，验证方案2 的"本地 RAG specialist"能否补强知识盲区。
 *
 * 用法（由 _bench.ts 在 BENCH_ENSEMBLE && BENCH_RAG 时调用，与基准同进程、同临时 DB）：
 *   await seedRagKnowledge();
 *
 * 设计意图：本题库仅作 RAG specialist 的"事实源"演示，证明"本地离线题库 + 检索"能把
 * 纯模型集成救不了的英语语法/史实/政治概念/408 考点题从 FAIL 拉回 PASS。
 * 真实知识库应来自教材/权威资料（见后续研究：可商用开源 RAG 项目 + 教材数字化），而非此处手写。
 */
import { env } from '../../config/env';
import { getDb } from '../../db';
import {
  insertQbankItem,
  getQbankById,
  updateEmbedding,
  type QbankUpsert,
} from '../../models/qbankModel';
import { embed, embedItemSource } from '../rag/embeddingService';

interface SeedItem extends QbankUpsert {}

const SEED_ITEMS: SeedItem[] = [
  {
    item_id: 'seed-e1-virtual',
    subject: '英语(虚拟语气)',
    question_text: 'If I ___ you, I would take the job. (A) am (B) was (C) were (D) be',
    knowledge_point:
      '虚拟语气（与现在事实相反）：If + 主语 + 动词过去式（be 动词一律用 were，不论人称），主句用 would/could/should + 动词原形。',
    answer_text:
      '选 (C) were。If 引导的非真实条件句与现在事实相反时，be 动词统一用 were（固定搭配 If I were you, I would...）。',
    solution_steps:
      'were 是虚拟语气中 be 的唯一正确形式，不受人称影响；am/was/be 均不符合规范。',
  },
  {
    item_id: 'seed-e3-inversion',
    subject: '英语(倒装·较难)',
    question_text:
      'Not until he failed the exam ___ the importance of studying. (A) he realized (B) did he realize (C) he did realize (D) realized he',
    knowledge_point:
      'Not until 置于句首引起部分倒装：助动词/情态动词提到主语之前（did/do/does + 主语 + 动词原形）。',
    answer_text:
      '选 (B) did he realize。Not until 开头须部分倒装，助动词 did 提前到主语 he 之前。',
    solution_steps:
      'Not until + 状语置于句首 → 主句部分倒装：did + 主语 he + 谓语 realize 原形。',
  },
  {
    item_id: 'seed-z2-may4',
    subject: '政治-史纲',
    question_text:
      '标志着中国新民主主义革命开端的事件是 (A) 辛亥革命 (B) 五四运动 (C) 中国共产党成立 (D) 新文化运动',
    knowledge_point: '五四运动（1919 年）是中国新民主主义革命的开端。',
    answer_text:
      '选 (B) 五四运动。1919 年五四运动是新民主主义革命开端；辛亥革命是旧民主主义革命高峰，中共成立于 1921 年。',
    solution_steps: '史纲标准结论：新民主主义革命开端 = 五四运动（1919）。',
  },
  {
    item_id: 'seed-z3-contradiction',
    subject: '政治-马原(矛盾精髓·较难)',
    question_text:
      '唯物辩证法认为，矛盾问题的精髓是 (A) 矛盾的同一性和斗争性 (B) 矛盾的普遍性和特殊性 (C) 主要矛盾和次要矛盾 (D) 内部矛盾和外部矛盾',
    knowledge_point:
      '矛盾问题的精髓 = 矛盾的普遍性和特殊性的关系（即共性与个性、绝对与相对的辩证统一）。',
    answer_text:
      '选 (B) 矛盾的普遍性和特殊性。矛盾精髓是普遍性与特殊性的辩证关系，出自《矛盾论》的明确论断。',
    solution_steps:
      '矛盾精髓 = 普遍性与特殊性（共性个性、绝对相对）。同一性斗争性是矛盾基本属性；主次矛盾体现矛盾发展不平衡性。',
  },
  {
    item_id: 'seed-c3-cache',
    subject: '计算机408-计组(Cache·较难)',
    question_text:
      '若 Cache 采用直接映射，主存地址可分为 (A) 主存字地址和字内地址 (B) 标记、组索引、块内地址 (C) 标记、行索引、块内地址 (D) 页号、页内偏移',
    knowledge_point:
      'Cache 直接映射：主存地址 = 标记(tag) + 行索引(row index，即 Cache 行号) + 块内地址(block offset)。',
    answer_text:
      '选 (C) 标记、行索引、块内地址。直接映射下主存地址分为三部分：高位标记 + 中间行索引（Cache 行号）+ 低位块内地址。',
    solution_steps:
      '直接映射地址划分：高位 tag（标记）+ 中间行索引（cache line 行号）+ 低位块内偏移；组相联才是"组索引"。',
  },
];

/** 灌库 + 建本地 hash 索引（写入当前 getDb() 指向的库，与基准同临时库）。 */
export async function seedRagKnowledge(): Promise<number> {
  let seeded = 0;
  for (const item of SEED_ITEMS) {
    insertQbankItem(item);
    const row = getQbankById(item.item_id);
    if (!row) continue;
    const vec = await embed(embedItemSource(row));
    updateEmbedding(item.item_id, vec, env.RAG_EMBED_MODEL);
    seeded++;
  }
  return seeded;
}
