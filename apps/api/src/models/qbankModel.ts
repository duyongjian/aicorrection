/**
 * qbank_items 数据访问层（P1 题库 RAG）
 * 纯 SQLite 同栈，无原生向量依赖；向量以 JSON 数组存于 embedding_vec 列，
 * 由 vectorStore 在 Node 侧算余弦相似度。
 */
import crypto from 'node:crypto';
import { getDb } from '../db';
import { env } from '../config/env';
import { embed, embedItemSource } from '../services/rag/embeddingService';

/** 导入/落库用的输入（必填字段由导入脚本用 zod 校验，这里只声明完整结构）。 */
export interface QbankUpsert {
  item_id: string;
  subject: string;
  question_text: string;
  answer_text: string;
  knowledge_point: string;
  solution_steps?: string | null;
  grade_level?: string | null;
  difficulty?: number | null;
  source?: string | null;
  license?: string | null;
  cause_tags_json?: string | null;
  /** UGC 原始来源片段（来源合规留痕；开放集可空）。 */
  snippet?: string | null;
  /** 审核状态：pending（待审）| approved（已发布）| rejected（驳回）。默认 approved（种子/开放集直接可用）。 */
  review_status?: string | null;
  /** 匿名贡献者哈希（UGC 来源追踪，绝不存 PII）。 */
  contributor_hash?: string | null;
  /** 社区投票数，默认 0。 */
  votes?: number | null;
}

export interface QbankItem extends QbankUpsert {
  embedding_status: string;
  embedding_model: string | null;
  embedding_vec: string | null;
  created_at: string;
}

/**
 * 文本归一化哈希（用于 item_id 派生与去重）。
 * NFC 归一化确保不同 Unicode 组合形式的同一题干得到同一哈希；确定性、无随机。
 */
export function hashText(text: string): string {
  return crypto
    .createHash('sha1')
    .update((text ?? '').normalize('NFC'))
    .digest('hex')
    .slice(0, 16);
}

/** 写入/覆盖一条题库项；重复 item_id 覆盖（INSERT OR REPLACE）。落库后 embedding_status='pending'。 */
export function insertQbankItem(row: QbankUpsert): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO qbank_items (
        item_id, subject, question_text, answer_text, knowledge_point,
        solution_steps, grade_level, difficulty, source, license, cause_tags_json,
        snippet, review_status, contributor_hash, votes,
        embedding_status
      ) VALUES (
        @item_id, @subject, @question_text, @answer_text, @knowledge_point,
        @solution_steps, @grade_level, @difficulty, @source, @license, @cause_tags_json,
        @snippet, @review_status, @contributor_hash, @votes,
        'pending'
      )`
    )
    .run({
      item_id: row.item_id,
      subject: row.subject,
      question_text: row.question_text,
      answer_text: row.answer_text,
      knowledge_point: row.knowledge_point,
      solution_steps: row.solution_steps ?? null,
      grade_level: row.grade_level ?? null,
      difficulty: row.difficulty ?? null,
      source: row.source ?? null,
      license: row.license ?? null,
      cause_tags_json: row.cause_tags_json ?? null,
      snippet: row.snippet ?? null,
      // 种子 / 开放集默认 approved 直接可用；UGC 显式传 'pending'。
      review_status: row.review_status ?? 'approved',
      contributor_hash: row.contributor_hash ?? null,
      votes: row.votes ?? 0,
    });
}

/** 取待嵌入行（embedding_status!='done' 或 vec 为空）。 */
export function getAllQbankForEmbedding(): QbankItem[] {
  return getDb()
    .prepare(
      `SELECT * FROM qbank_items
       WHERE embedding_status <> 'done' OR embedding_vec IS NULL OR embedding_vec = ''`
    )
    .all() as QbankItem[];
}

export function getQbankById(item_id: string): QbankItem | undefined {
  return getDb()
    .prepare('SELECT * FROM qbank_items WHERE item_id = ?')
    .get(item_id) as QbankItem | undefined;
}

export function queryQbankBySubject(subject?: string): QbankItem[] {
  if (subject) {
    return getDb()
      .prepare('SELECT * FROM qbank_items WHERE subject = ?')
      .all(subject) as QbankItem[];
  }
  return getDb().prepare('SELECT * FROM qbank_items').all() as QbankItem[];
}

/** 更新向量 + 标记已索引（upsert 语义：vec、status、model 一并写入）。 */
export function updateEmbedding(
  item_id: string,
  vec: number[],
  model: string
): void {
  getDb()
    .prepare(
      `UPDATE qbank_items
       SET embedding_vec = ?, embedding_status = 'done', embedding_model = ?
       WHERE item_id = ?`
    )
    .run(JSON.stringify(vec), model, item_id);
}

/** 按审核状态拉取题库项（D 路线：审核台读取 pending 项）。 */
export function getQbankByReviewStatus(status: string): QbankItem[] {
  return getDb()
    .prepare('SELECT * FROM qbank_items WHERE review_status = ?')
    .all(status) as QbankItem[];
}

/**
 * UGC 入库入口（BD 方案 D 路线：学生作答 → 标注 → 沉淀为题库）。
 *
 * 写入策略：
 *  - source='ugc'，review_status='pending'（需经人工/模型审核才发布），
 *    votes=0，contributor_hash 存匿名哈希（绝不存学生 PII），created_at 由库默认值生成。
 *  - item_id 由题干归一化哈希派生（前缀 ugc-），天然去重：同一题干重复提交覆盖而非新增。
 *  - 入库后立即生成 embedding（复用 embed + 回落逻辑），使新题尽快进入 RAG 检索；
 *    若嵌入失败不阻塞入库（status 仍为 pending，可经 rag:index 补建）。
 *
 * @returns 落库的 item_id
 */
export async function upsertUgcItem(input: {
  question: string;
  answer: string;
  knowledge_point?: string;
  snippet?: string | null;
  contributorHash: string;
  difficulty?: number | null;
  /** 可选学科（四大学科 slug：math/english/politics/logic/other）；未提供归入 'other'。 */
  subject?: string;
}): Promise<string> {
  const item_id = `ugc-${hashText(input.question)}`;
  const subject =
    input.subject && input.subject.trim() ? input.subject.trim() : 'other';

  insertQbankItem({
    item_id,
    subject,
    question_text: input.question,
    answer_text: input.answer,
    knowledge_point: input.knowledge_point ?? '',
    solution_steps: null,
    grade_level: null,
    difficulty: input.difficulty ?? 3,
    source: 'ugc',
    license: null,
    cause_tags_json: null,
    snippet: input.snippet ?? null,
    review_status: 'pending',
    contributor_hash: input.contributorHash,
    votes: 0,
  });

  // 立即生成 embedding（与 MMMLU 导入管线一致）。
  try {
    const item = getQbankById(item_id);
    if (item) {
      const vec = await embed(embedItemSource(item));
      updateEmbedding(item_id, vec, env.RAG_EMBED_MODEL);
    }
  } catch (e) {
    // 嵌入失败不阻塞入库：status 仍为 pending，后续 rag:index 可补建。
    // eslint-disable-next-line no-console
    console.warn(
      `[qbankModel] UGC ${item_id} 向量生成失败，留待 rag:index：${(e as Error).message}`
    );
  }
  return item_id;
}
