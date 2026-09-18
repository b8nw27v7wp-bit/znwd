import type { KnowledgeChunk } from './loader.js';
import { expandQueryText } from './synonyms.js';

export interface RetrievedChunk extends KnowledgeChunk {
  score: number;
  /** 命中的查询词条数（去重） */
  matchedTokens: number;
  /** 命中的词条（按权重降序，便于阈值标定与日志排查） */
  matched: string[];
}

const STOPWORDS = new Set([
  '的', '了', '和', '与', '在', '是', '有', '请', '什么', '如何', '怎么', '吗', '呢', '啊',
  '我', '你', '他', '我们', '这', '那', '能', '会', '要', '可以',
  'the', 'a', 'an', 'of', 'to', 'and', 'is', 'in', 'for', 'on', 'how', 'what',
]);

function isCjk(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0xf900 && c <= 0xfaff)
  );
}

/**
 * 中文按 bigram 切词，**不再把单字计入词条**。
 * 单字命中（如「天」「上」「好」）会让任意闲聊问题都拿到分数，
 * 是「什么都能答」的根因；bigram 才有区分度。
 */
function queryTokens(text: string): string[] {
  const lower = text.toLowerCase().replace(/[^\p{L}\p{N}一-鿿]+/gu, ' ');
  const out: string[] = [];
  const latin = lower.match(/[a-z0-9]+/g) || [];
  for (const t of latin) if (!STOPWORDS.has(t) && t.length > 1) out.push(t);

  const chars = [...lower].filter((ch) => isCjk(ch));
  for (let i = 0; i + 1 < chars.length; i++) {
    const a = chars[i];
    const b = chars[i + 1];
    if (STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
    out.push(a + b);
  }
  return out;
}

/** 文档侧词频（bigram + 拉丁词） */
function docTokens(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  const lower = text.toLowerCase();
  const latin = lower.match(/[a-z0-9]{2,}/g) || [];
  for (const t of latin) freq.set(t, (freq.get(t) || 0) + 1);
  const chars = [...lower].filter((ch) => isCjk(ch));
  for (let i = 0; i + 1 < chars.length; i++) {
    const bi = chars[i] + chars[i + 1];
    freq.set(bi, (freq.get(bi) || 0) + 1);
  }
  return freq;
}

interface Scored {
  score: number;
  matched: string[];
}

function scoreText(
  tokens: string[],
  idf: Map<string, number>,
  text: string,
  boost: number,
): Scored {
  const freq = docTokens(text);
  const matched: Array<{ t: string; w: number }> = [];
  let hit = 0;
  for (const t of tokens) {
    const f = freq.get(t);
    if (!f) continue;
    const w = idf.get(t) ?? 1;
    hit += w * (1 + Math.log(1 + f));
    matched.push({ t, w });
  }
  matched.sort((a, b) => b.w - a.w);
  return { score: (hit * boost) / Math.sqrt(tokens.length + 1), matched: matched.map((m) => m.t) };
}

/** 关键词路：bigram + IDF 加权 + 标题/标签加权 */
export class Retriever {
  private chunks: KnowledgeChunk[] = [];
  private idf = new Map<string, number>();

  replace(chunks: KnowledgeChunk[]): void {
    this.chunks = chunks;
    this.idf = buildIdf(chunks);
  }

  list(): KnowledgeChunk[] {
    return this.chunks;
  }

  /** 词条的逆文档频率，供评测/标定查看 */
  idfOf(token: string): number | undefined {
    return this.idf.get(token);
  }

  retrieve(query: string, topK = 4): RetrievedChunk[] {
    const expanded = expandQueryText(query);
    const tokens = [...new Set(queryTokens(expanded))];
    if (tokens.length === 0 || this.chunks.length === 0) return [];

    const scored = this.chunks
      .map((c) => {
        const title = scoreText(tokens, this.idf, c.title, 2.2);
        const zone = scoreText(tokens, this.idf, `${c.zone} ${c.zoneTitle} ${(c.tags || []).join(' ')}`, 1.5);
        const body = scoreText(tokens, this.idf, c.text, 1);
        const matched = [...new Set([...title.matched, ...zone.matched, ...body.matched])];
        return {
          ...c,
          score: title.score + zone.score + body.score,
          matchedTokens: matched.length,
          matched,
        };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, topK);
  }
}

export function buildIdf(chunks: KnowledgeChunk[]): Map<string, number> {
  const df = new Map<string, number>();
  const n = Math.max(chunks.length, 1);
  for (const c of chunks) {
    const seen = new Set(docTokens(`${c.title} ${c.zoneTitle} ${(c.tags || []).join(' ')} ${c.text}`).keys());
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log(1 + n / (1 + d)));
  return idf;
}
