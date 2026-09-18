import { promises as fs } from 'node:fs';
import path from 'node:path';

export class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private readonly max = 200) {}

  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.map.delete(first);
    }
  }

  get size() {
    return this.map.size;
  }

  clear() {
    this.map.clear();
  }
}

export function answerCacheKey(message: string, model: string): string {
  return `${model}::${message.trim().toLowerCase().slice(0, 300)}`;
}

export interface CachedAnswer {
  answer: string;
  sources: unknown[];
  mode: string;
  provider: string;
  retrieval: string;
  cached: boolean;
}

export class JsonlStore {
  private chain: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(dir: string, name: string) {
    this.file = path.join(dir, `${name}.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
  }

  append(obj: Record<string, unknown>): void {
    const line = JSON.stringify({ ...obj, at: obj.at ?? Date.now() }) + '\n';
    this.chain = this.chain
      .then(async () => {
        await this.ensureDir();
        await fs.appendFile(this.file, line, 'utf8');
      })
      .catch(() => {});
  }

  get path() {
    return this.file;
  }

  async readTail(limit = 50): Promise<Array<Record<string, unknown>>> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      return lines.slice(-limit).map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return {};
        }
      });
    } catch {
      return [];
    }
  }
}

export function adminOk(header: string | string[] | undefined, token: string | undefined): boolean {
  if (!token) return true;
  const h = Array.isArray(header) ? header[0] : header;
  const raw = (h || '').replace(/^Bearer\s+/i, '');
  return raw === token;
}
