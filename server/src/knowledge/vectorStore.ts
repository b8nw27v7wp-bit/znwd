import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cosine } from '../embedding/types.js';
import type { EmbeddingProvider } from '../embedding/types.js';
import type { KnowledgeChunk } from './loader.js';

export interface VectorHit {
  id: string;
  score: number;
  chunk: KnowledgeChunk;
}

interface IndexFile {
  version: number;
  provider: string;
  dims: number;
  fingerprint: string;
  updatedAt: string;
  items: Array<{ id: string; vector: number[] }>;
}

const INDEX_VERSION = 1;

function fingerprintChunks(chunks: KnowledgeChunk[]): string {
  const parts = chunks.map((c) => `${c.id}\u0001${c.title}\u0001${c.text.length}\u0001${hashStr(c.text)}`);
  parts.sort();
  return hashStr(parts.join('\n'));
}

function hashStr(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
    h2 = (h2 + s.charCodeAt(i) * 31) | 0;
  }
  return `${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}`;
}

export interface VecData {
  vectors: Map<string, number[]>;
  byId: Map<string, KnowledgeChunk>;
  providerName: string;
  dims: number;
  fingerprint: string;
}

function emptyVecData(): VecData {
  return {
    vectors: new Map(),
    byId: new Map(),
    providerName: '',
    dims: 0,
    fingerprint: '',
  };
}

/** 本地 JSON 向量库：构建/加载写入临时 Map，成功后整包原子替换 data。 */
export class VectorStore {
  private data: VecData = emptyVecData();

  constructor(
    private readonly embedder: EmbeddingProvider,
    private readonly indexFile: string,
  ) {}

  /** 供检索端固定引用，避免 search 过程中混用新旧代 */
  snapshot(): Readonly<VecData> {
    return this.data;
  }

  private embedText(chunk: KnowledgeChunk): string {
    return `${chunk.title}\n${chunk.zoneTitle || ''}\n${chunk.tags?.join(' ') || ''}\n${chunk.text}`;
  }

  async build(chunks: KnowledgeChunk[]): Promise<void> {
    const nextById = new Map<string, KnowledgeChunk>();
    const nextVectors = new Map<string, number[]>();
    const providerName = this.embedder.name;
    const fingerprint = fingerprintChunks(chunks);
    let dims = 0;

    const BATCH = 32;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const vecs = await this.embedder.embed(batch.map((c) => this.embedText(c)));
      batch.forEach((c, j) => {
        const v = vecs[j] || [];
        nextById.set(c.id, c);
        nextVectors.set(c.id, v);
        if (v.length) dims = v.length;
      });
    }

    await this.persist(nextVectors, providerName, dims, fingerprint, chunks);

    this.data = {
      vectors: nextVectors,
      byId: nextById,
      providerName,
      dims,
      fingerprint,
    };
  }

  private async persist(
    vectors: Map<string, number[]>,
    provider: string,
    dims: number,
    fingerprint: string,
    chunks: KnowledgeChunk[],
  ): Promise<void> {
    const payload: IndexFile = {
      version: INDEX_VERSION,
      provider,
      dims,
      fingerprint,
      updatedAt: new Date().toISOString(),
      items: chunks.map((c) => ({ id: c.id, vector: vectors.get(c.id) || [] })),
    };
    await fs.mkdir(path.dirname(this.indexFile), { recursive: true });
    const tmp = this.indexFile + '.' + process.pid + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.rename(tmp, this.indexFile);
  }

  /** 指纹/provider/条数一致才复用；失败时不改动现有索引 */
  async tryLoad(chunks: KnowledgeChunk[]): Promise<boolean> {
    const fp = fingerprintChunks(chunks);
    try {
      const raw = await fs.readFile(this.indexFile, 'utf8');
      const data = JSON.parse(raw) as IndexFile;
      if (
        data.version !== INDEX_VERSION ||
        data.provider !== this.embedder.name ||
        !Array.isArray(data.items) ||
        data.fingerprint !== fp
      ) {
        return false;
      }
      const nextById = new Map<string, KnowledgeChunk>();
      for (const c of chunks) nextById.set(c.id, c);
      const nextVectors = new Map<string, number[]>();
      let dims = 0;
      let ok = 0;
      for (const item of data.items) {
        if (nextById.has(item.id) && Array.isArray(item.vector) && item.vector.length) {
          nextVectors.set(item.id, item.vector);
          dims = item.vector.length;
          ok++;
        }
      }
      if (ok > 0 && ok === chunks.length) {
        this.data = {
          vectors: nextVectors,
          byId: nextById,
          providerName: this.embedder.name,
          dims,
          fingerprint: fp,
        };
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async search(query: string, topK = 8): Promise<VectorHit[]> {
    return this.searchOn(this.data, query, topK);
  }

  /** 在固定 data 引用上检索（generation 安全） */
  async searchOn(data: Readonly<VecData>, query: string, topK = 8): Promise<VectorHit[]> {
    if (data.vectors.size === 0) return [];
    const [q] = await this.embedder.embed([query]);
    if (!q || !q.length) return [];

    const hits: VectorHit[] = [];
    for (const [id, vec] of data.vectors) {
      const chunk = data.byId.get(id);
      if (!chunk) continue;
      const score = cosine(q, vec);
      hits.push({ id, score, chunk });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  stats() {
    const d = this.data;
    return {
      provider: d.providerName || this.embedder.name,
      semantic: this.embedder.semantic,
      dims: d.dims,
      vectors: d.vectors.size,
      fingerprint: d.fingerprint,
      indexFile: this.indexFile,
    };
  }

  /** 向量路是否具备语义能力（bag 特征哈希为 false） */
  semantic(): boolean {
    return this.embedder.semantic;
  }
}
