import { promises as fs } from 'node:fs';
import path from 'node:path';
import { messageLogFields, type LogMessageMode } from './errors.js';

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

/** K3：cache key 含索引 generation，reload 后旧代答案不会误命中 */
export function answerCacheKey(message: string, model: string, indexGen = 0): string {
  return `${model}::g${indexGen}::${message.trim().toLowerCase().slice(0, 300)}`;
}

export interface CachedAnswer {
  answer: string;
  sources: unknown[];
  mode: string;
  provider: string;
  retrieval: string;
  cached: boolean;
}

export interface JsonlStoreOptions {
  maxBytes?: number;
  messageMode?: LogMessageMode;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export class JsonlStore {
  private chain: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly baseName: string;
  private readonly maxBytes: number;
  readonly messageMode: LogMessageMode;

  constructor(dir: string, name: string, opts: JsonlStoreOptions = {}) {
    this.baseName = name;
    this.file = path.join(dir, name + '.jsonl');
    this.maxBytes = opts.maxBytes ?? 5_000_000;
    this.messageMode = opts.messageMode ?? 'hash';
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const st = await fs.stat(this.file);
      if (st.size < this.maxBytes) return;
      const day = new Date().toISOString().slice(0, 10);
      const dir = path.dirname(this.file);
      let target = path.join(dir, this.baseName + '.' + day + '.jsonl');
      let n = 0;
      while (await pathExists(target)) {
        n += 1;
        target = path.join(dir, this.baseName + '.' + day + '.' + n + '.jsonl');
      }
      await fs.rename(this.file, target);
    } catch {
      // file may not exist yet
    }
  }

  /** 写入前脱敏：默认 hash，不落盘完整 message */
  prepare(obj: Record<string, unknown>): Record<string, unknown> {
    const rest = { ...obj };
    const message = rest.message;
    delete rest.message;
    if (typeof message === 'string' && !rest.messagePreview) {
      Object.assign(rest, messageLogFields(message, this.messageMode));
    }
    return rest;
  }

  append(obj: Record<string, unknown>): void {
    const payload = this.prepare(obj);
    const line = JSON.stringify({ ...payload, at: payload.at ?? Date.now() }) + '\n';
    this.chain = this.chain
      .then(async () => {
        await this.ensureDir();
        await this.rotateIfNeeded();
        await fs.appendFile(this.file, line, 'utf8');
      })
      .catch(() => {});
  }

  async flush(): Promise<void> {
    await this.chain;
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

export interface AdminOkOptions {
  /** true 时未配置 token 直接拒绝（生产） */
  requireToken?: boolean;
}

export function adminOk(
  header: string | string[] | undefined,
  token: string | undefined,
  opts: AdminOkOptions = {},
): boolean {
  if (!token) return !opts.requireToken;
  const h = Array.isArray(header) ? header[0] : header;
  const raw = (h || '').replace(/^Bearer\s+/i, '');
  return raw === token;
}
