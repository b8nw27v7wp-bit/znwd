import type { ChatCompletionInput, ChatCompletionResult, ChatModel } from './types.js';

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export class OpenAICompatChatModel implements ChatModel {
  readonly name = 'openai_compat';

  constructor(private readonly config: OpenAICompatConfig) {
    if (!config.baseUrl) throw new Error('LLM_BASE_URL is required for openai_compat');
    if (!config.model) throw new Error('LLM_MODEL is required for openai_compat');
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
    };
  }

  private url(): string {
    return this.config.baseUrl.replace(/\/$/, '') + '/chat/completions';
  }

  async complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 60_000);
    try {
      const res = await fetch(this.url(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.model,
          messages: input.messages,
          temperature: 0.3,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`LLM HTTP ${res.status}: ${t.slice(0, 400)}`);
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

  async *stream(input: ChatCompletionInput): AsyncGenerator<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 90_000);
    try {
      const res = await fetch(this.url(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.model,
          messages: input.messages,
          temperature: 0.3,
          stream: true,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const r = await this.complete(input);
        yield r.content;
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') return;
          try {
            const j = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const piece = j.choices?.[0]?.delta?.content;
            if (piece) yield piece;
          } catch {
            /* ignore */
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
