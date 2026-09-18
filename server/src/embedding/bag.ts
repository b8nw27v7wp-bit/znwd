import type { EmbeddingProvider } from './types.js';

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const latin = lower.match(/[a-z0-9]+/g) || [];
  const chars = [...lower].filter((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 0x4e00 && c <= 0x9fff;
  });
  const bigrams: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) {
    bigrams.push(chars[i] + chars[i + 1]);
  }
  return [...latin, ...chars, ...bigrams];
}

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 离线兜底：特征哈希 embedding。
 * 不是语义模型，但比纯关键词对同义表述更稳；配置 EMBED_PROVIDER=openai_compat 后改走真实向量。
 */
export class BagEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'bag';
  /** 特征哈希不是语义嵌入：向量路不得作为「无关键词命中」时的兜底 */
  readonly semantic = false;
  readonly dims: number;

  constructor(dims = 512) {
    this.dims = dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vec = new Array<number>(this.dims).fill(0);
      const tokens = tokenize(text);
      for (const t of tokens) {
        const idx = hashToken(t) % this.dims;
        const sign = (hashToken(t + '#s') & 1) === 0 ? 1 : -1;
        // 大组权重稍高
        const w = t.length > 1 ? 1.2 : 0.8;
        vec[idx] += sign * w;
      }
      const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
      if (norm > 0) {
        for (let i = 0; i < vec.length; i++) vec[i] /= norm;
      }
      return vec;
    });
  }
}
