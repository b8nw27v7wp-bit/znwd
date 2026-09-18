import type { KnowledgeChunk } from './loader.js';

export interface RetrievedChunk extends KnowledgeChunk {
  score: number;
}

const STOPWORDS = new Set([
  '的', '了', '和', '与', '在', '是', '有', '请', '什么', '如何', '怎么',
  'the', 'a', 'an', 'of', 'to', 'and', 'is', 'in', 'for', 'on',
]);

function isCjk(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0xf900 && c <= 0xfaff)
  );
}

/** 英文词 + 中文单字与二元组，提高中文短语命中 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase().replace(/[^\p{L}\p{N}一-鿿]+/gu, ' ');
  const tokens: string[] = [];
  const latin = lower.match(/[a-z0-9]+/g) || [];
  tokens.push(...latin.filter((t) => !STOPWORDS.has(t)));

  const chars = [...lower].filter((ch) => isCjk(ch));
  for (const ch of chars) {
    if (!STOPWORDS.has(ch)) tokens.push(ch);
  }
  for (let i = 0; i + 1 < chars.length; i++) {
    const bi = chars[i] + chars[i + 1];
    if (!STOPWORDS.has(chars[i]) && !STOPWORDS.has(chars[i + 1])) {
      tokens.push(bi);
    }
  }
  return tokens;
}

function scoreText(queryTokens: string[], doc: string, titleBoost = 1): number {
  const bodyTokens = tokenize(doc);
  if (bodyTokens.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const t of bodyTokens) freq.set(t, (freq.get(t) || 0) + 1);

  let hit = 0;
  const seen = new Set<string>();
  for (const q of queryTokens) {
    if (seen.has(q)) continue;
    seen.add(q);
    const f = freq.get(q) || 0;
    if (f > 0) {
      const weight = q.length > 1 ? 1.25 : 0.7;
      hit += weight * (1 + Math.log(1 + f));
    }
  }
  if (titleBoost > 1) {
    // 标题命中单独加权由调用方拼 title 文本体现
    return (hit * titleBoost) / Math.sqrt(queryTokens.length + 1);
  }
  return hit / Math.sqrt(queryTokens.length + 1);
}

/** 轻量关键词检索（中文 bigram + 标题加权） */
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
      .map((c) => {
        const titleScore = scoreText(qTokens, c.title, 2.2);
        const bodyScore = scoreText(qTokens, c.text, 1);
        return {
          ...c,
          score: titleScore + bodyScore,
        };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, topK);
  }
}
