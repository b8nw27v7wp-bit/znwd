import type { EmbeddingProvider } from './types.js';
import { BagEmbeddingProvider } from './bag.js';
import { OpenAICompatEmbeddingProvider } from './openaiCompat.js';

export function createEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const provider = (env.EMBED_PROVIDER || 'bag').toLowerCase();

  if (provider === 'openai_compat') {
    return new OpenAICompatEmbeddingProvider({
      baseUrl: env.EMBED_BASE_URL || env.LLM_BASE_URL || '',
      apiKey: env.EMBED_API_KEY || env.LLM_API_KEY || '',
      model: env.EMBED_MODEL || '',
      dims: env.EMBED_DIMS ? Number(env.EMBED_DIMS) : undefined,
    });
  }

  if (provider !== 'bag') {
    throw new Error(`Unknown EMBED_PROVIDER: ${provider} (bag | openai_compat)`);
  }

  return new BagEmbeddingProvider(env.EMBED_BAG_DIMS ? Number(env.EMBED_BAG_DIMS) : 512);
}

export type { EmbeddingProvider } from './types.js';
export { cosine } from './types.js';
