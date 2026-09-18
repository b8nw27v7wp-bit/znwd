export interface EmbeddingProvider {
  readonly name: string;
  readonly dims: number | 'auto';
  /**
   * 是否为语义向量：bag 特征哈希为 false（其向量路只等于模糊关键词匹配，
   * 不能用来给「无关问题」兜底命中），openai_compat 为 true。
   */
  readonly semantic: boolean;
  embed(texts: string[]): Promise<number[][]>;
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
