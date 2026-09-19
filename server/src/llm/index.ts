import { MockChatModel } from './mock.js';
import { OpenAICompatChatModel } from './openaiCompat.js';
import type { ChatModel } from './types.js';

export function createChatModel(env: NodeJS.ProcessEnv = process.env): ChatModel {
  const provider = (env.LLM_PROVIDER || 'mock').toLowerCase();

  if (provider === 'openai_compat') {
    return new OpenAICompatChatModel({
      baseUrl: env.LLM_BASE_URL || '',
      apiKey: env.LLM_API_KEY || '',
      model: env.LLM_MODEL || '',
      timeoutMs: env.LLM_TIMEOUT_MS ? Number(env.LLM_TIMEOUT_MS) : undefined,
      maxRetries: env.LLM_MAX_RETRIES !== undefined ? Number(env.LLM_MAX_RETRIES) : undefined,
      retryBaseMs: env.LLM_RETRY_BASE_MS ? Number(env.LLM_RETRY_BASE_MS) : undefined,
    });
  }

  if (provider !== 'mock') {
    throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
  }

  return new MockChatModel();
}
