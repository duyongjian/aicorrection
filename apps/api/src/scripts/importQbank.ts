/**
 * 题库导入脚本（P1）
 *
 * 读取 JSONL（每行一条 qbank 项）或 CSV，校验必填字段后写入 SQLite（INSERT OR REPLACE，
 * 重复 item_id 覆盖）。写入后 embedding_status='pending'，由 buildQbankIndex 建向量索引。
 *
 * 用法：
 *   tsx src/scripts/importQbank.ts [path.jsonl|path.csv]
 * 默认路径：apps/api/scripts/seed_qbank.jsonl（相对 cwd=apps/api）
 *
 * 必填：item_id / subject / question_text / answer_text / knowledge_point
 * 可选：solution_steps / grade_level / difficulty / source / license / cause_tags_json
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDb } from '../db';
import { insertQbankItem } from '../models/qbankModel';

const RowSchema = z.object({
  item_id: z.string().min(1),
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

type QbankRow = z.infer<typeof RowSchema>;

/** 极简 CSV 解析（支持引号包裹、内部双引号转义）。无表头推断，要求首行为表头。 */
function parseCsv(content: string): QbankRow[] {
  const rows: string[][] = [];
  let field = '';
  let inQuotes = false;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() && rows.length === 0) continue;
    let row: string[] = [];
    field = '';
    inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else {
        field += ch;
      }
    }
    row.push(field);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
  }
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const out: QbankRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const obj: Record<string, string> = {};
    rows[r].forEach((val, idx) => {
      obj[header[idx] ?? `col${idx}`] = val;
    });
    out.push(obj as unknown as QbankRow);
  }
  return out;
}

function parseJsonl(content: string): QbankRow[] {
  const out: QbankRow[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      throw new Error(`第 ${i + 1} 行不是合法 JSON：${(e as Error).message}`);
    }
    out.push(raw as QbankRow);
  }
  return out;
}

function parseRows(content: string, file: string): QbankRow[] {
  if (file.toLowerCase().endsWith('.csv')) return parseCsv(content);
  return parseJsonl(content);
}

function main(): void {
  const arg = process.argv[2];
  const file = arg
    ? path.resolve(process.cwd(), arg)
    : path.resolve(process.cwd(), 'scripts/seed_qbank.jsonl');

  if (!fs.existsSync(file)) {
    console.error(`[importQbank] 种子文件不存在：${file}`);
    process.exit(1);
  }

  const content = fs.readFileSync(file, 'utf-8');
  const rawRows = parseRows(content, file);

  // zod 校验必填 + 类型
  const rows: QbankRow[] = [];
  rawRows.forEach((raw, idx) => {
    const parsed = RowSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`第 ${idx + 1} 条字段校验失败：${parsed.error.message}`);
    }
    rows.push(parsed.data);
  });

  if (rows.length === 0) {
    console.error('[importQbank] 未解析到任何题库项，退出。');
    process.exit(1);
  }

  // 触发迁移（确保 qbank_items 表存在）
  getDb();

  let n = 0;
  for (const r of rows) {
    insertQbankItem({
      item_id: r.item_id,
      subject: r.subject,
      question_text: r.question_text,
      answer_text: r.answer_text,
      knowledge_point: r.knowledge_point,
      solution_steps: r.solution_steps ?? null,
      grade_level: r.grade_level ?? null,
      difficulty: r.difficulty ?? null,
      source: r.source ?? null,
      license: r.license ?? null,
      cause_tags_json: r.cause_tags_json ?? null,
    });
    n++;
  }
  console.log(`[importQbank] 已导入/覆盖 ${n} 条题库项（embedding_status='pending'）。`);
}

main();
