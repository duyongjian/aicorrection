/**
 * qbank_items 数据访问层（P1 题库 RAG）
 * 纯 SQLite 同栈，无原生向量依赖；向量以 JSON 数组存于 embedding_vec 列，
 * 由 vectorStore 在 Node 侧算余弦相似度。
 */
import { getDb } from '../db';

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
}

export interface QbankItem extends QbankUpsert {
  embedding_status: string;
  embedding_model: string | null;
  embedding_vec: string | null;
  created_at: string;
}

/** 写入/覆盖一条题库项；重复 item_id 覆盖（INSERT OR REPLACE）。落库后 embedding_status='pending'。 */
export function insertQbankItem(row: QbankUpsert): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO qbank_items (
        item_id, subject, question_text, answer_text, knowledge_point,
        solution_steps, grade_level, difficulty, source, license, cause_tags_json,
        embedding_status
      ) VALUES (
        @item_id, @subject, @question_text, @answer_text, @knowledge_point,
        @solution_steps, @grade_level, @difficulty, @source, @license, @cause_tags_json,
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
