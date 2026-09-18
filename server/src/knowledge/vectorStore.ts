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

/** 本地 JSON 向量库：中小知识库够用，零外部服务 */
export class VectorStore {
  private vectors = new Map<string, number[]>();
  private byId = new Map<string, KnowledgeChunk>();
  private providerName = '';
  private dims = 0;
  private fingerprint = '';

  constructor(
    private readonly embedder: EmbeddingProvider,
    private readonly indexFile: string,
  ) {}

  private embedText(chunk: KnowledgeChunk): string {
    return `${chunk.title}\n${chunk.zoneTitle || ''}\n${chunk.tags?.join(' ') || ''}\n${chunk.text}`;
  }

  async build(chunks: KnowledgeChunk[]): Promise<void> {
    this.byId.clear();
    this.vectors.clear();
    this.providerName = this.embedder.name;
    this.fingerprint = fingerprintChunks(chunks);

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
      fingerprint: this.fingerprint,
      updatedAt: new Date().toISOString(),
      items: chunks.map((c) => ({ id: c.id, vector: this.vectors.get(c.id) || [] })),
    };
    await fs.mkdir(path.dirname(this.indexFile), { recursive: true });
    await fs.writeFile(this.indexFile, JSON.stringify(payload), 'utf8');
  }

  /** 指纹/provider/条数一致才复用索引，避免知识正文变更后仍用旧向量 */
  async tryLoad(chunks: KnowledgeChunk[]): Promise<boolean> {
    this.byId.clear();
    for (const c of chunks) this.byId.set(c.id, c);

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
      this.vectors.clear();
      let ok = 0;
      for (const item of data.items) {
        if (this.byId.has(item.id) && Array.isArray(item.vector) && item.vector.length) {
          this.vectors.set(item.id, item.vector);
          this.dims = item.vector.length;
          ok++;
        }
      }
      if (ok > 0 && ok === chunks.length) {
        this.providerName = this.embedder.name;
        this.fingerprint = fp;
        return true;
      }
      return false;
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
      hits.push({ id, score, chunk });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  stats() {
    return {
      provider: this.providerName || this.embedder.name,
      dims: this.dims,
      vectors: this.vectors.size,
      fingerprint: this.fingerprint,
      indexFile: this.indexFile,
    };
  }
}
