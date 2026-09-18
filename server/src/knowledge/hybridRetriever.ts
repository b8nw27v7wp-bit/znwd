import type { KnowledgeChunk } from './loader.js';
import { Retriever, type RetrievedChunk } from './retriever.js';
import type { VectorStore } from './vectorStore.js';

export interface HybridHit extends RetrievedChunk {
  keywordScore: number;
  vectorScore: number;
  fuseScore: number;
}

export interface HybridStats {
  mode: 'keyword' | 'hybrid';
  keywordChunks: number;
  vector: ReturnType<VectorStore['stats']>;
  indexReady: boolean;
}

/** RRF 融合关键词与向量两路排序 */
function rrfFuse(
  keyword: RetrievedChunk[],
  vector: Array<{ id: string; score: number; chunk: KnowledgeChunk }>,
  k = 60,
): HybridHit[] {
  const acc = new Map<
    string,
    {
      chunk: KnowledgeChunk;
      keywordScore: number;
      vectorScore: number;
      kwRank?: number;
      vecRank?: number;
    }
  >();

  keyword.forEach((c, i) => {
    acc.set(c.id, {
      chunk: c,
      keywordScore: c.score,
      vectorScore: 0,
      kwRank: i + 1,
    });
  });

  vector.forEach((v, i) => {
    const prev = acc.get(v.id);
    if (prev) {
      prev.vectorScore = v.score;
      prev.vecRank = i + 1;
    } else {
      acc.set(v.id, {
        chunk: v.chunk,
        keywordScore: 0,
        vectorScore: v.score,
        vecRank: i + 1,
      });
    }
  });

  const out: HybridHit[] = [];
  for (const item of acc.values()) {
    const kw = item.kwRank ? 1 / (k + item.kwRank) : 0;
    const ve = item.vecRank ? 1 / (k + item.vecRank) : 0;
    const fuse = kw + ve + (item.kwRank && item.vecRank ? 0.01 : 0);
    if (fuse <= 0) continue;
    const c = item.chunk;
    out.push({
      id: c.id,
      title: c.title,
      sourcePath: c.sourcePath,
      text: c.text,
      zone: c.zone,
      zoneTitle: c.zoneTitle,
      tags: c.tags,
      score: Number(fuse.toFixed(6)),
      keywordScore: Number(item.keywordScore.toFixed(4)),
      vectorScore: Number(item.vectorScore.toFixed(4)),
      fuseScore: Number(fuse.toFixed(6)),
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}

export class HybridRetriever {
  private keyword = new Retriever();
  private indexReady = false;

  constructor(private readonly vectors: VectorStore) {}

  async replace(chunks: KnowledgeChunk[]): Promise<void> {
    this.keyword.replace(chunks);
    const loaded = await this.vectors.tryLoad(chunks);
    if (!loaded) {
      await this.vectors.build(chunks);
      this.indexReady = true;
    } else {
      this.indexReady = true;
    }
  }

  /** 兼容旧调用：同步关键词检索 */
  list(): KnowledgeChunk[] {
    return this.keyword.list();
  }

  retrieveKeyword(query: string, topK = 8): RetrievedChunk[] {
    return this.keyword.retrieve(query, topK);
  }

  async retrieve(query: string, topK = 4): Promise<HybridHit[]> {
    const kw = this.keyword.retrieve(query, Math.max(topK * 2, 8));
    let vec: Array<{ id: string; score: number; chunk: KnowledgeChunk }> = [];
    try {
      vec = await this.vectors.search(query, Math.max(topK * 2, 8));
    } catch {
      vec = [];
    }
    const fused = rrfFuse(kw, vec);
    return fused.slice(0, topK);
  }

  stats(): HybridStats {
    return {
      mode: 'hybrid',
      keywordChunks: this.keyword.list().length,
      vector: this.vectors.stats(),
      indexReady: this.indexReady,
    };
  }
}
