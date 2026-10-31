/**
 * MMMLU 开放题库导入管线（BD 方案 B 路线：开放数据集铺量基底）
 *
 * 合规前提（硬约束，来自任务）：
 *  - 仅采用 MIT 商用友好的 openai/MMMLU（中文 ZH_CN 子集，约 1.4 万题）。
 *  - C-Eval / CMMLU（CC BY-NC-SA 4.0）仅限内部评估/训练，绝不随产品分发 —— 本脚本只接 MMMLU。
 *  - 高考/公考真题等版权红线禁止入库再分发；国家中小学智慧教育平台禁止爬取。本脚本不触碰任何上述内容。
 *  - 所有处理本地完成：下载（如需）与解析均在用户本机，不外发任何数据。
 *
 * 行为：
 *  - 优先读取本地 CSV（默认 scripts/mmulu_zh.csv，可由 argv[2] 或 MMMLU_CSV 覆盖）。
 *  - 若本地文件缺失且带 --download 且设置了 MMMLU_HF_URL，则尝试 fetch 下载（带超时，不会死等）。
 *  - 否则打印精确的人工下载命令并退出 1（推荐：用户用 huggingface_hub 自行拉取合并）。
 *  - 字段映射：question←question；answer←选项字母(A-D)映射回选项文本；knowledge_point←MMMLU subject 名；
 *    subject←经 subject_map.json 归一到四大学科 slug（math/english/politics/logic/other）。
 *  - source='open_mmulu'，review_status='approved'（MIT 合规直接可用），license='MIT'，difficulty=默认 3，contributor_hash 空。
 *  - 去重：题干归一化 hash 派生 item_id（mmulu-<hash>），INSERT OR REPLACE 天然覆盖重复题干。
 *  - 入库后逐条生成 embedding（复用 embed 回落逻辑），使新题直接进 RAG 检索。
 *
 * 用法：
 *   tsx src/scripts/import_mmulu.ts [path/to/mmulu_zh.csv] [--download]
 *
 * 本地样例（仅供解析/映射自检，非真实数据）：
 *   question,options,answer,subject
 *   "1+1=?", "['1','2','3','4']", A, high_school_mathematics
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db';
import { env } from '../config/env';
import {
  insertQbankItem,
  getQbankById,
  updateEmbedding,
  hashText,
} from '../models/qbankModel';
import { embed, embedItemSource } from '../services/rag/embeddingService';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 应用四大学科枚举（与种子/检索一致）。 */
const APP_SUBJECTS = ['math', 'english', 'politics', 'logic', 'other'] as const;
/** 未映射学科归属（保持数据不丢；也可改为丢弃）。 */
const DEFAULT_SUBJECT = 'other';
const SOURCE = 'open_mmulu';
const REVIEW_STATUS = 'approved'; // MIT 合规，直接可用
const LICENSE = 'MIT';
const DEFAULT_DIFFICULTY = 3;

/** 加载学科映射表（与脚本同目录的 subject_map.json）。 */
function loadSubjectMap(): Record<string, string> {
  const p = path.resolve(__dirname, 'subject_map.json');
  const raw = fs.readFileSync(p, 'utf-8');
  const obj = JSON.parse(raw) as Record<string, unknown>;
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') map[k.toLowerCase()] = v;
  }
  return map;
}

const SUBJECT_MAP = loadSubjectMap();

/** 将 MMMLU subject 名归一到应用学科 slug（未命中 → DEFAULT_SUBJECT）。 */
function normalizeSubject(mmuluSubject: string): string {
  const key = (mmuluSubject ?? '').trim().toLowerCase();
  const mapped = SUBJECT_MAP[key];
  if (mapped && (APP_SUBJECTS as readonly string[]).includes(mapped)) return mapped;
  return DEFAULT_SUBJECT;
}

/**
 * 解析 MMMLU 的 options 字段（Python list 风格单引号，或标准 JSON 双引号）。
 * 例： "['text A', 'text B', 'text C', 'text D']" 或 '["a","b"]'。
 */
function parseOptions(raw: string): string[] {
  const s = (raw ?? '').trim();
  if (!s) return [];
  // 1) 标准 JSON（双引号）
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr.map((x) => String(x).trim());
  } catch {
    /* fall through */
  }
  // 2) Python list 风格：剥掉中括号，按单/双引号项提取
  const inner = s.replace(/^\[/, '').replace(/\]$/, '');
  const matches = inner.match(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g);
  if (matches && matches.length > 0) {
    return matches.map((m) =>
      m
        .slice(1, -1)
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .trim()
    );
  }
  // 3) 兜底：逗号拆分
  return inner
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/** 将答案字母(A-D)映射回选项文本；若已是文本则尽力匹配，最终兜底返回原值。 */
function mapAnswerToText(options: string[], answer: string): string {
  const a = (answer ?? '').trim().toUpperCase();
  const letterIdx = 'ABCD'.indexOf(a[0] ?? '');
  if (letterIdx >= 0 && letterIdx < options.length) {
    return options[letterIdx];
  }
  const exact = options.find((o) => o.trim() === a);
  if (exact) return exact;
  const contains = options.find(
    (o) => o.includes(a) || a.includes(o.trim())
  );
  if (contains) return contains;
  return a;
}

/** 极简 CSV 解析（支持双引号包裹与内部双引号转义；首行为表头；忽略全空行）。 */
function parseCsv(content: string): Record<string, string>[] {
  const rows: string[][] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
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
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const obj: Record<string, string> = {};
    rows[r].forEach((val, idx) => {
      obj[header[idx] ?? `col${idx}`] = val;
    });
    out.push(obj);
  }
  return out;
}

/** 打印精确的人工下载命令（推荐方式：用户本机用 huggingface_hub 拉取并合并为单 CSV）。 */
function printDownloadInstructions(defaultPath: string): void {
  // eslint-disable-next-line no-console
  console.error(
    `
[import_mmulu] 未找到本地 CSV（${defaultPath}）。
请在本机自行下载并合并 openai/MMMLU 的 ZH_CN 子集为单文件 CSV（列：question,options,answer,subject），
放到上述路径或经 argv[2]/MMMLU_CSV 指定，再重跑本脚本。

—— 方式一：huggingface_hub（推荐，MIT 许可，本地完成）——
pip install huggingface_hub
python - <<'PY'
from huggingface_hub import HfApi, hf_hub_download
import csv
repo = "openai/MMMLU"
api = HfApi()
paths = [p.rfilename for p in api.dataset_info(repo).siblings
         if p.rfilename.startswith("csv/ZH_CN/") and p.rfilename.endswith(".csv")]
out = "mmulu_zh.csv"
n = 0
with open(out, "w", newline="", encoding="utf-8") as fout:
    w = csv.writer(fout)
    w.writerow(["question", "options", "answer", "subject"])
    for p in paths:
        local = hf_hub_download(repo_id=repo, filename=p)
        with open(local, "r", encoding="utf-8") as fin:
            r = csv.reader(fin)
            header = next(r, None)
            idx = {name: i for i, name in enumerate(header)} if header else {}
            for row in r:
                if not row: continue
                col = lambda name, d="": row[idx[name]] if name in idx else (row[0] if len(row) > 0 else d)
                w.writerow([col("question"), col("options"), col("answer"), col("subject")])
                n += 1
print("merged", n, "rows ->", out)
PY

—— 方式二：git lfs 克隆后合并（同样本地完成）——
git lfs install
git clone https://huggingface.co/datasets/openai/MMMLU
# 将 csv/ZH_CN/**/*.csv 合并为 mmulu_zh.csv（保留 question,options,answer,subject 四列）

—— 可选：--download 自动拉取（需先设置 MMMLU_HF_URL 指向一个已合并好的单文件 URL）——
MMMLU_HF_URL=https://your-host/mmulu_zh.csv tsx src/scripts/import_mmulu.ts --download
`.trim()
  );
}

/** 尝试从 MMMLU_HF_URL 下载（带 60s 超时；失败不抛错，返回 false）。 */
async function tryDownload(targetPath: string): Promise<boolean> {
  const url = process.env.MMMLU_HF_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.error('[import_mmulu] --download 已指定但未设置 MMMLU_HF_URL，跳过自动下载。');
    return false;
  }
  // eslint-disable-next-line no-console
  console.log(`[import_mmulu] 尝试从 ${url} 下载...`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(targetPath, buf);
    // eslint-disable-next-line no-console
    console.log(`[import_mmulu] 下载完成 → ${targetPath} (${buf.length} bytes)`);
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[import_mmulu] 下载失败（不阻塞，请改用人工下载）：${(e as Error).message}`);
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantDownload = args.includes('--download');
  const pathArg = args.find((a) => !a.startsWith('--'));

  const defaultPath = path.resolve(process.cwd(), 'scripts/mmulu_zh.csv');
  const file = pathArg
    ? path.resolve(process.cwd(), pathArg)
    : process.env.MMMLU_CSV
      ? path.resolve(process.cwd(), process.env.MMMLU_CSV)
      : defaultPath;

  if (!fs.existsSync(file)) {
    if (wantDownload) {
      const ok = await tryDownload(file);
      if (!ok) {
        printDownloadInstructions(file);
        process.exit(1);
      }
    } else {
      printDownloadInstructions(file);
      process.exit(1);
    }
  }

  // 触发迁移，确保 qbank_items 表与新列存在
  getDb();

  const content = fs.readFileSync(file, 'utf-8');
  const records = parseCsv(content);

  const seen = new Set<string>();
  const bySubject: Record<string, number> = {};
  let inserted = 0;
  let skipped = 0;

  for (const row of records) {
    const question = (row['question'] ?? '').trim();
    if (!question) {
      skipped++;
      continue;
    }
    const qid = `mmulu-${hashText(question)}`;
    if (seen.has(qid)) {
      skipped++; // 重复题干去重
      continue;
    }
    seen.add(qid);

    const options = parseOptions(row['options'] ?? '');
    const answerText = mapAnswerToText(options, row['answer'] ?? '');
    const mmuluSubject = (row['subject'] ?? '').trim();
    const subject = normalizeSubject(mmuluSubject);

    bySubject[subject] = (bySubject[subject] ?? 0) + 1;

    insertQbankItem({
      item_id: qid,
      subject,
      question_text: question,
      answer_text: answerText,
      // 知识点记为 MMMLU 原始学科名（便于溯源）；如需中文知识点可由标注环节补充。
      knowledge_point: mmuluSubject,
      solution_steps: null,
      grade_level: null,
      difficulty: DEFAULT_DIFFICULTY,
      source: SOURCE,
      license: LICENSE,
      cause_tags_json: null,
      snippet: null,
      review_status: REVIEW_STATUS,
      contributor_hash: null,
      votes: 0,
    });
    inserted++;
  }

  // 入库后逐条生成 embedding（复用 local-hash / bge 回落；断点续跑：已 done 跳过）。
  let embDone = 0;
  let embSkip = 0;
  for (const id of seen) {
    const item = getQbankById(id);
    if (!item) continue;
    if (item.embedding_status === 'done' && item.embedding_vec) continue;
    try {
      const vec = await embed(embedItemSource(item));
      updateEmbedding(id, vec, env.RAG_EMBED_MODEL);
      embDone++;
    } catch (e) {
      embSkip++;
      // eslint-disable-next-line no-console
      console.warn(`[import_mmulu] 跳过嵌入 ${id}：${(e as Error).message}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[import_mmulu] 解析 ${records.length} 行 → 去重后插入 ${inserted} 条（跳过 ${skipped} 条含重复/空题干）。`
  );
  // eslint-disable-next-line no-console
  console.log(`[import_mmulu] 学科分布：${JSON.stringify(bySubject)}`);
  // eslint-disable-next-line no-console
  console.log(
    `[import_mmulu] 向量索引：${embDone} 条完成${embSkip ? `，${embSkip} 条失败留待 rag:index` : ''}。`
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`[import_mmulu] 失败：${(e as Error).message}`);
  process.exit(1);
});
