/**
 * 可插拔离线嵌入服务（P1 题库 RAG）
 *
 * 设计约束（来自任务硬要求）：
 *  - 默认嵌入 = localHashEmbed（确定性哈希词袋，D=384，无模型下载、无原生编译依赖）。
 *  - 不引入 sqlite-vec / lancedb / @xenova/transformers 等原生依赖。
 *  - 向量以 JSON 数组存于 qbank_items.embedding_vec 列，由 vectorStore 在 Node 侧算余弦。
 *  - bge（本地 onnx bge-m3，1024 维语义嵌入）通过 RAG_EMBED_MODEL 开关切换；
 *    缺模型 / 加载 / 推理失败一律优雅回落 localHashEmbed，绝不因缺模型而崩。
 *
 * 确定性：同一文本永远得到同一向量，故建索引与检索两端可独立运行、结果可复现。
 */
import { env } from '../../config/env';
import { l2Normalize } from '../../utils/math';
import { bgeEmbed, isBgeModelAvailable } from './bgeEmbedder';

/** 默认向量维度（local-hash）。若日后接 bge 等，维度需与此一致或由模型决定。 */
export const RAG_DIM = 384;

/** 支持切换的嵌入方案。 */
export type EmbedModel = 'local-hash' | 'bge';

const CJK_RE = /[一-鿿㐀-䶿]/;

/**
 * 分词：中文/日文汉字按单字切分，并补相邻汉字二元组（bigram）以捕捉局部语序；
 * 拉丁字母与数字连续串作为整词保留（如 dy/dx、sin、x2）。空格/标点忽略。
 * 统一小写，保证大小写无关的命中。
 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  let prevCjk: string | null = null;
  const latinRe = /[a-z0-9]+/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = latinRe.exec(lower)) !== null) {
    // 上一段拉丁串之前的字符（多为 CJK / 标点）
    for (const ch of lower.slice(lastIndex, m.index)) {
      if (/\s/.test(ch)) {
        prevCjk = null;
        continue;
      }
      tokens.push(ch);
      if (CJK_RE.test(ch)) {
        if (prevCjk) tokens.push(prevCjk + ch);
        prevCjk = ch;
      } else {
        prevCjk = null;
      }
    }
    tokens.push(m[0]);
    prevCjk = null;
    lastIndex = m.index + m[0].length;
  }
  // 收尾段
  for (const ch of lower.slice(lastIndex)) {
    if (/\s/.test(ch)) {
      prevCjk = null;
      continue;
    }
    tokens.push(ch);
    if (CJK_RE.test(ch)) {
      if (prevCjk) tokens.push(prevCjk + ch);
      prevCjk = ch;
    } else {
      prevCjk = null;
    }
  }
  return tokens;
}

/** FNV-1a 32-bit 字符串哈希（稳定、无随机数）。 */
function stringHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 确定性哈希词袋嵌入。
 * 词频取平方根阻尼，避免高频字（如"的"）主导；哈希到 D 维后 L2 归一化。
 */
export function localHashEmbed(text: string, dim: number = RAG_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) return l2Normalize(vec);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [tok, freq] of counts) {
    const idx = stringHash(tok) % dim;
    vec[idx] += Math.sqrt(freq);
  }
  return l2Normalize(vec);
}

/**
 * 取一条题库项的"语义文本"：题干 + 知识点 + （解题步骤优先于答案）。
 * 检索时以此向量与"学生题干"向量做余弦，命中相似题。
 */
export function embedItemSource(item: {
  question_text: string;
  knowledge_point: string;
  answer_text: string;
  solution_steps?: string | null;
}): string {
  return [item.question_text, item.knowledge_point, item.solution_steps || item.answer_text]
    .join('\n')
    .trim();
}

/** 当前生效的嵌入方案（读取 env）。 */
export function activeEmbedModel(): EmbedModel {
  return env.RAG_EMBED_MODEL === 'bge' ? 'bge' : 'local-hash';
}

/**
 * 嵌入单条文本。模型选择：
 *  - 'local-hash'（默认）：确定性哈希词袋，零依赖、永不崩。
 *  - 'bge'：本地 onnx bge-m3 语义嵌入（见 bgeEmbedder）。
 *    缺模型 / 加载 / 推理失败 → 优雅回落 localHashEmbed（并 console.warn），归因流程照常。
 *    注意：bge 为 1024 维，local-hash 为 384 维；切到 bge 后必须重建索引
 *    （运行 npm run rag:import / rag:index），旧 384 维向量与新 1024 维不兼容。
 */
export async function embed(text: string): Promise<number[]> {
  if (activeEmbedModel() === 'bge') {
    // 短路检测：模型文件缺失则直接回落，避免无谓的联网 / 加载尝试。
    if (!isBgeModelAvailable()) {
      console.warn(
        `[embeddingService] RAG_EMBED_MODEL=bge 但 BGE_MODEL_DIR(${env.BGE_MODEL_DIR}) 无模型文件，回落 local-hash。`
      );
      return localHashEmbed(text);
    }
    try {
      return await bgeEmbed(text);
    } catch (e) {
      console.warn(
        `[embeddingService] bge 嵌入失败，回落 local-hash：${(e as Error).message}`
      );
      return localHashEmbed(text);
    }
  }
  return localHashEmbed(text);
}

/** 批量嵌入（逐条，保持与单条一致的可回落语义）。 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (const t of texts) out.push(await embed(t));
  return out;
}
