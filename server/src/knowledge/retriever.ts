import type { KnowledgeChunk } from './loader.js';

export interface RetrievedChunk extends KnowledgeChunk {
  score: number;
}

const STOPWORDS = new Set(
  ['的', '了', '和', '与', '在', '是', '有', '请', '什么', '如何', '怎么', 'the', 'a', 'an', 'of', 'to', 'and', 'is', 'in'],
);

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const latin = lower.match(/[a-z0-9]+/g) || [];
  const cjk = lower.match(/[一-鿿]/g) || [];
  // 中文按字 + 英文按词，简单可解释的检索
  const tokens = [...latin, ...cjk];
  return tokens.filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function scoreText(queryTokens: string[], doc: string): number {
  const docTokens = tokenize(doc);
  if (docTokens.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const t of docTokens) freq.set(t, (freq.get(t) || 0) + 1);

  let hit = 0;
  const seen = new Set<string>();
  for (const q of queryTokens) {
    if (seen.has(q)) continue;
    seen.add(q);
    const f = freq.get(q) || 0;
    if (f > 0) hit += 1 + Math.log(1 + f);
  }
  return hit / Math.sqrt(queryTokens.length + 1);
}

/** 轻量关键词/BM25 风格检索，零外部依赖 */
export class Retriever {
  private chunks: KnowledgeChunk[] = [];

  replace(chunks: KnowledgeChunk[]): void {
    this.chunks = chunks;
  }

  list(): KnowledgeChunk[] {
    return this.chunks;
  }

  retrieve(query: string, topK = 4): RetrievedChunk[] {
    const qTokens = tokenize(query);
    if (qTokens.length === 0 || this.chunks.length === 0) return [];

    const scored = this.chunks
      .map((c) => ({
        ...c,
        score: scoreText(qTokens, `${c.title}\n${c.text}`),
      }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, topK);
  }
}
