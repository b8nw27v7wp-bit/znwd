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
  updatedAt: string;
  items: Array<{ id: string; vector: number[] }>;
}

const INDEX_VERSION = 1;

/** 本地 JSON 向量库：中小知识库够用，零外部服务 */
export class VectorStore {
  private vectors = new Map<string, number[]>();
  private byId = new Map<string, KnowledgeChunk>();
  private providerName = '';
  private dims = 0;

  constructor(
    private readonly embedder: EmbeddingProvider,
    private readonly indexFile: string,
  ) {}

  private embedText(chunk: KnowledgeChunk): string {
    return `${chunk.title}\n${chunk.zoneTitle || ''}\n${chunk.text}`;
  }

  async build(chunks: KnowledgeChunk[]): Promise<void> {
    this.byId.clear();
    this.vectors.clear();
    this.providerName = this.embedder.name;

    const BATCH = 32;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const vecs = await this.embedder.embed(batch.map((c) => this.embedText(c)));
      batch.forEach((c, j) => {
        const v = vecs[j] || [];
        this.byId.set(c.id, c);
        this.vectors.set(c.id, v);
        if (v.length) this.dims = v.length;
      });
    }

    await this.persist(chunks);
  }

  private async persist(chunks: KnowledgeChunk[]): Promise<void> {
    const payload: IndexFile = {
      version: INDEX_VERSION,
      provider: this.providerName,
      dims: this.dims,
      updatedAt: new Date().toISOString(),
      items: chunks.map((c) => ({ id: c.id, vector: this.vectors.get(c.id) || [] })),
    };
    await fs.mkdir(path.dirname(this.indexFile), { recursive: true });
    await fs.writeFile(this.indexFile, JSON.stringify(payload), 'utf8');
  }

  /** 索引文件存在且 provider 一致时尝试加载（chunks 仍以 loader 为准） */
  async tryLoad(chunks: KnowledgeChunk[]): Promise<boolean> {
    this.byId.clear();
    for (const c of chunks) this.byId.set(c.id, c);

    try {
      const raw = await fs.readFile(this.indexFile, 'utf8');
      const data = JSON.parse(raw) as IndexFile;
      if (
        data.version !== INDEX_VERSION ||
        data.provider !== this.embedder.name ||
        !Array.isArray(data.items)
      ) {
        return false;
      }
      this.vectors.clear();
      let ok = 0;
      for (const item of data.items) {
        if (this.byId.has(item.id) && Array.isArray(item.vector) && item.vector.length) {
          this.vectors.set(item.id, item.vector);
          this.dims = item.vector.length;
          ok++;
        }
      }
      return ok > 0 && ok === chunks.length;
    } catch {
      return false;
    }
  }

  async search(query: string, topK = 8): Promise<VectorHit[]> {
    if (this.vectors.size === 0) return [];
    const [q] = await this.embedder.embed([query]);
    if (!q || !q.length) return [];

    const hits: VectorHit[] = [];
    for (const [id, vec] of this.vectors) {
      const chunk = this.byId.get(id);
      if (!chunk) continue;
      const score = cosine(q, vec);
      if (score > 0) hits.push({ id, score, chunk });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  stats() {
    return {
      provider: this.providerName || this.embedder.name,
      dims: this.dims,
      vectors: this.vectors.size,
      indexFile: this.indexFile,
    };
  }
}
