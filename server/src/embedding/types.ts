export interface EmbeddingProvider {
  readonly name: string;
  readonly dims: number | 'auto';
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

function l2(vec: number[]): number[] {
  let s = 0;
  for (const x of vec) s += x * x;
  if (s <= 0) return vec.map(() => 0);
  const inv = 1 / Math.sqrt(s);
  return vec.map((x) => x * inv);
}
