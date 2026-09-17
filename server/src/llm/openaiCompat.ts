import type { ChatCompletionInput, ChatCompletionResult, ChatModel } from './types.js';

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

/** OpenAI 兼容 /chat/completions，可接内网 vLLM、网关等 */
export class OpenAICompatChatModel implements ChatModel {
  readonly name = 'openai_compat';

  constructor(private readonly config: OpenAICompatConfig) {
    if (!config.baseUrl) throw new Error('LLM_BASE_URL is required for openai_compat');
    if (!config.model) throw new Error('LLM_MODEL is required for openai_compat');
  }

  async complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
    const url = this.config.baseUrl.replace(/\/$/, '') + '/chat/completions';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 60_000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: input.messages,
          temperature: 0.3,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('LLM returned empty content');
      return { content, provider: this.name };
    } finally {
      clearTimeout(timer);
    }
  }
}
