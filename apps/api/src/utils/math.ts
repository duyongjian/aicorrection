/**
 * 轻量数值工具（RAG 余弦检索用）
 * 纯 Node 实现，无原生依赖。
 */

/**
 * 余弦相似度。输入应为 L2 归一化向量（embeddingService 已归一化），
 * 故结果即点积。两向量维度不一致时按较短者对齐。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** L2 归一化（原地返回新数组）。零向量原样返回。 */
export function l2Normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v.slice();
  return v.map((x) => x / norm);
}

/** 四舍五入保留指定小数位。 */
export function roundTo(value: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}
