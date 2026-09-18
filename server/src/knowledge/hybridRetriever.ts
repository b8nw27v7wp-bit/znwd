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
  generation: number;
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

interface Snapshot {
  gen: number;
  keyword: Retriever;
  ready: boolean;
}

export class HybridRetriever {
  private snapshot: Snapshot = { gen: 0, keyword: new Retriever(), ready: false };
  private replaceChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly vectors: VectorStore) {}

  generation(): number {
    return this.snapshot.gen;
  }

  /** 串行 replace；完成后原子切换 keyword 快照并递增 generation */
  async replace(chunks: KnowledgeChunk[]): Promise<void> {
    const run = async () => {
      const nextKeyword = new Retriever();
      nextKeyword.replace(chunks);
      const loaded = await this.vectors.tryLoad(chunks);
      if (!loaded) {
        await this.vectors.build(chunks);
      }
      const prev = this.snapshot.gen;
      this.snapshot = {
        gen: prev + 1,
        keyword: nextKeyword,
        ready: true,
      };
    };
    const p = this.replaceChain.then(run, run);
    this.replaceChain = p;
    await p;
  }

  list(): KnowledgeChunk[] {
    return this.snapshot.keyword.list();
  }

  retrieveKeyword(query: string, topK = 8): RetrievedChunk[] {
    return this.snapshot.keyword.retrieve(query, topK);
  }

  async retrieve(query: string, topK = 4): Promise<HybridHit[]> {
    const snap = this.snapshot;
    const kw = snap.keyword.retrieve(query, Math.max(topK * 2, 8));
    // 固定向量 data 引用；命中 chunk 对齐到 keyword 快照，避免 reload 中混代
    const vecData = this.vectors.snapshot();
    let vecRaw: Array<{ id: string; score: number; chunk: KnowledgeChunk }> = [];
    try {
      vecRaw = await this.vectors.searchOn(vecData, query, Math.max(topK * 2, 8));
    } catch {
      vecRaw = [];
    }
    const chunkById = new Map(snap.keyword.list().map((c) => [c.id, c] as const));
    const vec = vecRaw.flatMap((v) => {
      const chunk = chunkById.get(v.id);
      return chunk ? [{ id: v.id, score: v.score, chunk }] : [];
    });
    const fused = rrfFuse(kw, vec);
    return fused.slice(0, topK);
  }

  stats(): HybridStats {
    return {
      mode: 'hybrid',
      keywordChunks: this.snapshot.keyword.list().length,
      vector: this.vectors.stats(),
      indexReady: this.snapshot.ready,
      generation: this.snapshot.gen,
    };
  }
}
