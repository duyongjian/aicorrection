/**
 * 教材 / 自有笔记 入库管线（真实知识库，替代 _seedRag 的临时 demo）
 *
 * 目的：把「开发者自有 / 正版摘录 / 公开大纲」的结构化 Markdown 笔记，切成知识点，
 *       写入 qbank_items（embedding_status='pending'），再由 buildQbankIndex 建向量索引，
 *      形成本地、零外发、可检索的归因事实库。
 *
 * ⚠️ 数据主权 / 版权硬约束（P0）：
 *   仅允许录入以下三种来源的笔记，严禁录入盗版 PDF / 未授权扫描件：
 *     1) 开发者本人整理的结构化学习笔记（source=developer-notes）
 *     2) 正版购买教材的合法摘录（需标注书名/页码，source 注明）
 *     3) 公开可引用的教学大纲 / 官方考纲（source=public-outline）
 *   任何来源都不得离开本机；本脚本只做本地 SQLite 写入，无任何网络外发。
 *
 * Markdown 约定（每个 .md 一个学科/章节）：
 *   ---
 *   subject: english          # 可选：english|politics|computer|math|logic|other
 *   source: 开发者自有学习笔记  # 可选：来源说明（满足上面三类之一）
 *   license: developer-own     # 可选：授权/来源标签
 *   ---
 *   # 文档标题
 *   引言（可选，置于首个 ## 之前）
 *   ## 知识点标题（= knowledge_point）
 *   该知识点的讲解正文……
 *   ## 另一个知识点
 *   ……
 *
 * 切片：每个 `## ` 小节 = 一条知识点；正文过长（>CHUNK_CHARS）按空行分段再切，保持单条可检索。
 * item_id 由（subject+文档标题+小节标题+段序号）归一化哈希派生 → 同内容重复运行幂等覆盖。
 *
 * 用法：
 *   tsx src/scripts/ingestTextbook.ts [目录] [--index] [--dry-run]
 *   npm run rag:ingest-textbook            # 默认读 scripts/textbooks/
 *   npm run rag:ingest-textbook -- --index # 入库后立刻建向量索引
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDb } from '../db';
import { insertQbankItem, hashText, type QbankUpsert } from '../models/qbankModel';
import { buildQbankIndex } from './buildQbankIndex';

const DEFAULT_DIR = path.resolve(process.cwd(), 'scripts/textbooks');
const CHUNK_CHARS = 800;

interface Frontmatter {
  subject?: string;
  source?: string;
  license?: string;
}

interface NoteSection {
  heading: string;
  body: string;
}

interface ParsedNote {
  title: string;
  fm: Frontmatter;
  sections: NoteSection[];
  preamble: string;
}

/** 解析 YAML 风格 frontmatter（仅支持 `key: value` 平铺，够用即可，不引第三方）。 */
function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw };
  const fmBlock = m[1];
  const body = m[2];
  const fm: Frontmatter = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
    if (kv) {
      const k = kv[1].toLowerCase();
      const v = kv[2].trim();
      if (k === 'subject') fm.subject = v;
      else if (k === 'source') fm.source = v;
      else if (k === 'license') fm.license = v;
    }
  }
  return { fm, body };
}

/** 由文件名推断学科（english_*.md / politics_*.md / computer_*.md …）。 */
function inferSubject(filename: string): string {
  const base = path.basename(filename, '.md').toLowerCase();
  for (const s of ['english', 'politics', 'computer', 'math', 'logic']) {
    if (base.startsWith(s)) return s;
  }
  return 'other';
}

/** 把 Markdown 正文切成小节（## 标题 + 正文），并抽出文档 # 标题与引言。 */
function parseNote(content: string): ParsedNote {
  const { fm, body } = parseFrontmatter(content);
  const lines = body.split(/\r?\n/);
  let title = '';
  const sections: NoteSection[] = [];
  let preamble = '';
  let cur: NoteSection | null = null;

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    if (h1 && !title) {
      title = h1[1].trim();
      continue;
    }
    if (h2) {
      cur = { heading: h2[1].trim(), body: '' };
      sections.push(cur);
      continue;
    }
    if (cur) {
      cur.body += (cur.body ? '\n' : '') + line;
    } else {
      preamble += (preamble ? '\n' : '') + line;
    }
  }

  // 没有 ## 小节 → 整篇作为一个知识点（用文档标题作 knowledge_point）
  if (sections.length === 0 && (title || preamble.trim())) {
    sections.push({ heading: title || '概述', body: preamble.trim() });
  }
  return { title, fm, sections, preamble: preamble.trim() };
}

/** 长正文分段切条（按空行分段，聚合到 ≤ CHUNK_CHARS）。 */
function chunkBody(body: string): string[] {
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length <= 1) return [body.trim()];
  const out: string[] = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > CHUNK_CHARS && buf) {
      out.push(buf.trim());
      buf = p;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

interface IngestResult {
  file: string;
  items: number;
}

function ingestFile(file: string, dryRun: boolean): IngestResult {
  const content = fs.readFileSync(file, 'utf-8');
  const note = parseNote(content);
  const subject = note.fm.subject ?? inferSubject(file);
  let count = 0;

  for (const sec of note.sections) {
    const chunks = chunkBody(sec.body);
    chunks.forEach((chunk, idx) => {
      const item_id = `txt-${subject}-${hashText(`${note.title}|${sec.heading}|${idx}`)}`;
      const row: QbankUpsert = {
        item_id,
        subject,
        // 以自然问句作为 question_text，提升对学生真实提问的召回
        question_text: note.title
          ? `请讲解「${sec.heading}」（出自：${note.title}）`
          : `请讲解「${sec.heading}」`,
        answer_text: chunk,
        knowledge_point: sec.heading,
        solution_steps: null,
        grade_level: null,
        difficulty: null,
        source: note.fm.source ?? 'developer-notes',
        license: note.fm.license ?? 'developer-own',
        review_status: 'approved',
      };
      if (!dryRun) insertQbankItem(row);
      count++;
    });
  }
  return { file: path.basename(file), items: count };
}

export async function ingestTextbooks(
  dir: string = DEFAULT_DIR,
  opts: { index?: boolean; dryRun?: boolean } = {}
): Promise<void> {
  if (!fs.existsSync(dir)) {
    console.error(`[ingestTextbook] 目录不存在：${dir}`);
    console.error('   请在该目录下放置开发者自有/正版摘录/公开大纲的 .md 笔记（见 scripts/textbooks/README.md）。');
    process.exit(1);
  }
  // 触发迁移，确保 qbank_items 表与列存在
  getDb();

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => path.join(dir, f));

  if (files.length === 0) {
    console.error(`[ingestTextbook] ${dir} 下没有可导入的 .md 笔记。`);
    process.exit(1);
  }

  if (opts.dryRun) {
    console.log(`[ingestTextbook] DRY-RUN：将导入 ${files.length} 个文件，不写入数据库。`);
  }
  let total = 0;
  for (const f of files) {
    const r = ingestFile(f, !!opts.dryRun);
    total += r.items;
    console.log(`[ingestTextbook] ${opts.dryRun ? '(dry) ' : ''}${r.file} → ${r.items} 条知识点`);
  }
  console.log(`[ingestTextbook] 共 ${opts.dryRun ? '计划' : '已'}导入 ${total} 条（embedding_status='pending'）。`);

  if (opts.index && !opts.dryRun) {
    console.log('[ingestTextbook] 开始建向量索引…');
    await buildQbankIndex();
  } else if (!opts.dryRun) {
    console.log('[ingestTextbook] 提示：运行 `npm run rag:index`（或管理后台"重建索引"）生成向量，RAG 才能命中。');
  }
}

// 仅当本文件被直接执行时自动跑；被其它模块 import 时不自启。
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dirArg = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? DEFAULT_DIR;
  const index = process.argv.includes('--index');
  const dryRun = process.argv.includes('--dry-run');
  ingestTextbooks(dirArg, { index, dryRun }).catch((e) => {
    console.error(`[ingestTextbook] 失败：${(e as Error).message}`);
    process.exit(1);
  });
}
