import type { KnowledgeChunk } from './loader.js';
import { expandQueryParts } from './synonyms.js';

export interface RetrievedChunk extends KnowledgeChunk {
  score: number;
  /** 命中的查询词条数（去重） */
  matchedTokens: number;
  /** 命中的词条（按权重降序，便于阈值标定与日志排查） */
  matched: string[];
}

/** 标题 / 展区标签 / 正文 的加权系数（默认值见 DEFAULT_SCORING） */
export const TITLE_BOOST = 2.2;
export const ZONE_BOOST = 1.0;
export const BODY_BOOST = 1;
/** 同义词扩展词的权重：扩展是提示不是要求（原查询词 = 1） */
export const EXPANSION_WEIGHT = 0.45;
/** 词频增益上限：长文档靠反复出现某个泛词取胜是噪声，不是相关性 */
export const MAX_TF_BOOST = 2.2;

export interface ScoringOptions {
  titleBoost: number;
  zoneBoost: number;
  bodyBoost: number;
  expansionWeight: number;
  maxTfBoost: number;
  /**
   * 正文长度归一化强度（BM25 的 b）：0 = 关闭。
   * 长片段（抓来的网页长文、重复啰嗦的文档）天然命中更多 bigram，
   * 会把短而精准的片段挤下去，必须按长度打折。
   */
  lengthB: number;
}

/**
 * 打分参数默认值。以下数值由 `scripts/tune-scoring.mjs` 在评测用例 + 域外样本上
 * 网格搜索选出（top1 0.9333 / top3 0.9667、闸门余量 5.28），不是拍脑袋定的。
 * 改语料或改同义词表后请重跑该脚本，别手调。
 */
export const DEFAULT_SCORING: ScoringOptions = {
  titleBoost: 2.2,
  zoneBoost: 1.0,
  bodyBoost: 1,
  expansionWeight: 0.45,
  maxTfBoost: 2.2,
  lengthB: 0,
};

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

interface WeightedToken {
  t: string;
  /** 词条权重：原查询词 1，扩展词 EXPANSION_WEIGHT */
  w: number;
}

/** 查询词条（带权重）：原查询词满权，扩展词降权，重复词条取最大值 */
function weightedTokens(query: string, opts: ScoringOptions): WeightedToken[] {
  const { original, extras } = expandQueryParts(query);
  const acc = new Map<string, number>();
  for (const t of queryTokens(original)) acc.set(t, 1);
  for (const t of queryTokens(extras.join(' '))) {
    if (!acc.has(t)) acc.set(t, opts.expansionWeight);
  }
  return [...acc].map(([t, w]) => ({ t, w }));
}

function scoreText(
  tokens: WeightedToken[],
  idf: Map<string, number>,
  text: string,
  boost: number,
  opts: ScoringOptions,
  precomputedFreq?: Map<string, number>,
): Scored {
  const freq = precomputedFreq ?? docTokens(text);
  const matched: Array<{ t: string; w: number }> = [];
  let hit = 0;
  for (const { t, w: tokenWeight } of tokens) {
    const f = freq.get(t);
    if (!f) continue;
    const w = (idf.get(t) ?? 1) * tokenWeight;
    hit += w * Math.min(1 + Math.log(1 + f), opts.maxTfBoost);
    matched.push({ t, w });
  }
  matched.sort((a, b) => b.w - a.w);
  // 归一化按**原查询词条数**（不含扩展）：分数回答的是「这段文字有多贴合用户真正问的」，
  // 否则同义词表一改，所有分数整体平移，阈值也跟着漂。
  const base = Math.max(1, tokens.filter((x) => x.w >= 1).length);
  return { score: (hit * boost) / Math.sqrt(base + 1), matched: matched.map((m) => m.t) };
}

/** 关键词路：bigram + IDF 加权 + 标题/标签加权 */
export class Retriever {
  private chunks: KnowledgeChunk[] = [];
  private idf = new Map<string, number>();
  private avgLen = 1;
  private readonly opts: ScoringOptions;

  constructor(opts: Partial<ScoringOptions> = {}) {
    this.opts = { ...DEFAULT_SCORING, ...opts };
  }

  replace(chunks: KnowledgeChunk[]): void {
    this.chunks = chunks;
    this.idf = buildIdf(chunks);
    const lens = chunks.map((c) => docTokens(c.text).size);
    this.avgLen = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 1;
  }

  list(): KnowledgeChunk[] {
    return this.chunks;
  }

  /** 词条的逆文档频率，供评测/标定查看 */
  idfOf(token: string): number | undefined {
    return this.idf.get(token);
  }

  retrieve(query: string, topK = 4): RetrievedChunk[] {
    const tokens = weightedTokens(query, this.opts);
    if (tokens.length === 0 || this.chunks.length === 0) return [];

    const scored = this.chunks
      .map((c) => {
        const title = scoreText(tokens, this.idf, c.title, this.opts.titleBoost, this.opts);
        const zone = scoreText(
          tokens,
          this.idf,
          `${c.zone} ${c.zoneTitle} ${(c.tags || []).join(' ')}`,
          this.opts.zoneBoost,
          this.opts,
        );
        const bodyFreq = docTokens(c.text);
        const body = scoreText(tokens, this.idf, c.text, this.opts.bodyBoost, this.opts, bodyFreq);
        // 长度归一化（BM25 的 b）：长片段命中更多 bigram 是长度优势，不是相关性
        const lenNorm =
          this.opts.lengthB > 0
            ? Math.max(0.3, 1 + this.opts.lengthB * (bodyFreq.size / this.avgLen - 1))
            : 1;
        const matched = [...new Set([...title.matched, ...zone.matched, ...body.matched])];
        return {
          ...c,
          score: title.score + zone.score + body.score / lenNorm,
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
