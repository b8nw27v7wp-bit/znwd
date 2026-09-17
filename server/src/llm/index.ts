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
    });
  }

  if (provider !== 'mock') {
    throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
  }

  return new MockChatModel();
}
