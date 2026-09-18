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
  /** 向量路是否具备语义能力（bag 为 false，此时 mode 恒为 keyword） */
  semantic: boolean;
  degradedReason: string | null;
  thresholds: { minKeywordScore: number; minVectorScore: number };
}

export interface HybridOptions {
  /** 关键词路最低分：低于此值且向量路不可用时视为「知识库未覆盖」 */
  minKeywordScore?: number;
  /** 语义向量路最低余弦（仅 semantic 向量生效） */
  minVectorScore?: number;
}

export type RetrievalReason = 'keyword_hit' | 'vector_hit' | 'below_threshold' | 'no_candidates';

export interface RetrievalDiagnostics {
  mode: 'keyword' | 'hybrid';
  semantic: boolean;
  degraded: boolean;
  gated: boolean;
  reason: RetrievalReason;
  keywordBestScore: number;
  vectorBestCosine: number;
  candidates: number;
  thresholds: { minKeywordScore: number; minVectorScore: number };
}

export interface RetrievalOutcome {
  hits: HybridHit[];
  diagnostics: RetrievalDiagnostics;
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
      matched: string[];
      matchedTokens: number;
      kwRank?: number;
      vecRank?: number;
    }
  >();

  keyword.forEach((c, i) => {
    acc.set(c.id, {
      chunk: c,
      keywordScore: c.score,
      vectorScore: 0,
      matched: c.matched,
      matchedTokens: c.matchedTokens,
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
        matched: [],
        matchedTokens: 0,
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
      matchedTokens: item.matchedTokens,
      matched: item.matched,
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

/** 由 scripts/calibrate.ts 在现有知识库上标定：在域最低 5.05 / 域外最高 2.64（取区间中点 3.8） */
export const DEFAULT_MIN_KEYWORD_SCORE = 3.8;
export const DEFAULT_MIN_VECTOR_SCORE = 0.35;

export class HybridRetriever {
  private snapshot: Snapshot = { gen: 0, keyword: new Retriever(), ready: false };
  private replaceChain: Promise<unknown> = Promise.resolve();
  private readonly minKeywordScore: number;
  private readonly minVectorScore: number;

  constructor(
    private readonly vectors: VectorStore,
    options: HybridOptions = {},
  ) {
    this.minKeywordScore = options.minKeywordScore ?? DEFAULT_MIN_KEYWORD_SCORE;
    this.minVectorScore = options.minVectorScore ?? DEFAULT_MIN_VECTOR_SCORE;
  }

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

  /** 原始融合结果（不套相关性闸门），供评测与排查使用 */
  async retrieve(query: string, topK = 4): Promise<HybridHit[]> {
    return (await this.retrieveWithDiagnostics(query, { topK, applyGate: false })).hits;
  }

  /**
   * 带诊断检索：关键词路低于阈值、且语义向量路不可用或余弦过低时返回空命中，
   * 让上层明确回答「知识库未覆盖」，而不是拿无关片段硬答。
   */
  async retrieveWithDiagnostics(
    query: string,
    options: { topK?: number; applyGate?: boolean } = {},
  ): Promise<RetrievalOutcome> {
    const topK = options.topK ?? 4;
    const applyGate = options.applyGate ?? true;
    const snap = this.snapshot;
    const kw = snap.keyword.retrieve(query, Math.max(topK * 2, 8));

    // 固定向量 data 引用；命中 chunk 对齐到 keyword 快照，避免 reload 中混代
    const vecData = this.vectors.snapshot();
    const semantic = this.vectors.semantic();
    let vecRaw: Array<{ id: string; score: number; chunk: KnowledgeChunk }> = [];
    if (vecData.vectors.size > 0) {
      try {
        vecRaw = await this.vectors.searchOn(vecData, query, Math.max(topK * 2, 8));
      } catch {
        vecRaw = [];
      }
    }
    const chunkById = new Map(snap.keyword.list().map((c) => [c.id, c] as const));
    const vec = vecRaw.flatMap((v) => {
      const chunk = chunkById.get(v.id);
      return chunk ? [{ id: v.id, score: v.score, chunk }] : [];
    });

    const keywordBestScore = kw[0]?.score ?? 0;
    const vectorBestCosine = vec[0]?.score ?? 0;
    const keywordPass = kw.length > 0 && keywordBestScore >= this.minKeywordScore;
    const vectorPass = semantic && vec.length > 0 && vectorBestCosine >= this.minVectorScore;

    let gated = false;
    let reason: RetrievalReason;
    if (keywordPass) {
      reason = 'keyword_hit';
    } else if (vectorPass) {
      reason = 'vector_hit';
    } else if (applyGate) {
      gated = true;
      reason = kw.length === 0 && vec.length === 0 ? 'no_candidates' : 'below_threshold';
    } else {
      reason = kw.length > 0 ? 'keyword_hit' : vec.length > 0 ? 'vector_hit' : 'no_candidates';
    }

    const useKeyword = gated ? [] : kw;
    const useVector = gated ? [] : vec;

    // mode 如实上报：只有语义向量真的参与融合时才算 hybrid
    const mode: 'keyword' | 'hybrid' = semantic && useVector.length > 0 ? 'hybrid' : 'keyword';
    const hits = rrfFuse(useKeyword, useVector).slice(0, topK);

    return {
      hits,
      diagnostics: {
        mode,
        semantic,
        degraded: !semantic,
        gated,
        reason,
        keywordBestScore: Number(keywordBestScore.toFixed(4)),
        vectorBestCosine: Number(vectorBestCosine.toFixed(4)),
        candidates: kw.length + vec.filter((v) => !kw.some((k) => k.id === v.id)).length,
        thresholds: {
          minKeywordScore: this.minKeywordScore,
          minVectorScore: this.minVectorScore,
        },
      },
    };
  }

  stats(): HybridStats {
    const semantic = this.vectors.semantic();
    const vs = this.vectors.stats();
    return {
      mode: semantic && vs.vectors > 0 ? 'hybrid' : 'keyword',
      keywordChunks: this.snapshot.keyword.list().length,
      vector: vs,
      indexReady: this.snapshot.ready,
      generation: this.snapshot.gen,
      semantic,
      degradedReason: semantic ? null : 'EMBED_PROVIDER=bag（特征哈希，非语义向量）',
      thresholds: {
        minKeywordScore: this.minKeywordScore,
        minVectorScore: this.minVectorScore,
      },
    };
  }
}
