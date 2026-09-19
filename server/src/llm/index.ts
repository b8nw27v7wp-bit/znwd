import { MockChatModel } from './mock.js';
import { OpenAICompatChatModel } from './openaiCompat.js';
import type { ChatModel } from './types.js';

/** LLM_EXTRA_BODY：JSON 字符串，合并进请求体（如 {"thinking":{"type":"disabled"}} 关思考模式） */
export function parseExtraBody(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    console.warn('[llm] LLM_EXTRA_BODY 必须是 JSON 对象，已忽略');
    return undefined;
  } catch (e) {
    console.warn(`[llm] LLM_EXTRA_BODY 解析失败，已忽略：${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}

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
      maxTokens: env.LLM_MAX_TOKENS ? Number(env.LLM_MAX_TOKENS) : undefined,
      extraBody: parseExtraBody(env.LLM_EXTRA_BODY),
    });
  }

  if (provider !== 'mock') {
    throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
  }

  return new MockChatModel();
}
