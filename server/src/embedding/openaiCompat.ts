import type { EmbeddingProvider } from './types.js';

export interface OpenAIEmbedConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dims?: number;
  timeoutMs?: number;
}

/** OpenAI 兼容 /embeddings，可接内网网关与 bge 等模型 */
export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai_compat';
  readonly semantic = true;
  readonly dims: number;

  constructor(private readonly config: OpenAIEmbedConfig) {
    if (!config.baseUrl) throw new Error('EMBED_BASE_URL or LLM_BASE_URL required');
    if (!config.model) throw new Error('EMBED_MODEL is required');
    this.dims = config.dims ?? 0;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const url = this.config.baseUrl.replace(/\/$/, '') + '/embeddings';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 60_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.config.model, input: texts }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Embeddings HTTP ${res.status}: ${t.slice(0, 400)}`);
      }
      const data = (await res.json()) as {
        data?: Array<{ embedding?: number[]; index?: number }>;
      };
      const rows = (data.data || []).map((d) => d.embedding || []);
      if (rows.length !== texts.length) {
        throw new Error(`Embeddings count mismatch: ${rows.length} != ${texts.length}`);
      }
      return rows;
    } finally {
      clearTimeout(timer);
    }
  }
}
