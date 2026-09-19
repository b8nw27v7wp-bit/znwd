import type { ChatCompletionInput, ChatCompletionResult, ChatModel } from './types.js';

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** 额外重试次数，默认 2（最多 3 次尝试） */
  maxRetries?: number;
  /** 退避基数，默认 1000ms */
  retryBaseMs?: number;
}

/** 智谱等网关的过载/限流业务码（HTTP 可能是 429，也可能是 200 带 error 体） */
const RETRYABLE_BUSINESS_CODES = new Set(['1302', '1305']);
/** 额度用尽类：重试无用，直接报错让运营去续费/换模型 */
const HARD_LIMIT_CODES = new Set(['1303', '1304']);
const OVERLOAD_HINT = /访问量过大|稍后再试|rate limit|too many requests|overload|temporarily unavailable/i;

export function isRetryableFailure(status: number, body: string): boolean {
  const m = body.match(/"code"\s*:\s*"?(\d{4})"?/);
  if (m && HARD_LIMIT_CODES.has(m[1]!)) return false;
  if (status === 408 || status === 429 || status >= 500) return true;
  if (OVERLOAD_HINT.test(body)) return true;
  return !!m && RETRYABLE_BUSINESS_CODES.has(m[1]!);
}

function backoffMs(attempt: number, base: number, retryAfter?: string | null): number {
  const header = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 15_000);
  const exp = Math.min(base * 2 ** attempt, 8000);
  return exp + Math.floor(Math.random() * 300);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
    readonly retryAfter?: string | null,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
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

  /** 单次 POST；非 2xx 抛 LlmHttpError（带 body 以便判断是否可重试） */
  private async post(payload: unknown, signal: AbortSignal): Promise<Response> {
    const res = await fetch(this.url(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new LlmHttpError(
        res.status,
        body,
        `LLM HTTP ${res.status}: ${body.slice(0, 300)}`,
        res.headers.get('retry-after'),
      );
    }
    return res;
  }

  /**
   * 过载/限流重试：免费或共享网关会返回 429/5xx，或 HTTP 200 带业务错误码（如智谱 1305）。
   * 只重试「还没拿到可用内容」的失败，退避 1s/2s…（尊重 retry-after），最多 maxRetries 次。
   */
  private async postWithRetry(payload: unknown, signal: AbortSignal): Promise<Response> {
    const maxRetries = this.config.maxRetries ?? 2;
    const base = this.config.retryBaseMs ?? 1000;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.post(payload, signal);
        // 有的网关用 200 包错误体
        const peek = await res.clone().text();
        if (/"error"\s*:/.test(peek) && isRetryableFailure(res.status, peek)) {
          throw new LlmHttpError(res.status, peek, `LLM business error: ${peek.slice(0, 300)}`);
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (signal.aborted) throw err;
        const status = err instanceof LlmHttpError ? err.status : 0;
        const body = err instanceof LlmHttpError ? err.body : String((err as Error)?.message ?? err);
        const retryable =
          err instanceof LlmHttpError
            ? isRetryableFailure(status, body)
            : /fetch failed|network|ECONN|ETIMEDOUT|socket hang up|terminated/i.test(body);
        if (!retryable || attempt === maxRetries) throw err;
        const wait = backoffMs(attempt, base, err instanceof LlmHttpError ? err.retryAfter : null);
        await sleep(wait);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async complete(input: ChatCompletionInput): Promise<ChatCompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 90_000);
    try {
      const res = await this.postWithRetry(
        {
          model: this.config.model,
          messages: input.messages,
          temperature: 0.3,
          stream: false,
        },
        controller.signal,
      );
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
        error?: { code?: string; message?: string };
      };
      if (data.error) {
        throw new LlmHttpError(200, JSON.stringify(data.error), `LLM error: ${data.error.message ?? ''}`);
      }
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('LLM returned empty content');
      return { content, provider: this.name };
    } finally {
      clearTimeout(timer);
    }
  }

  async *stream(input: ChatCompletionInput): AsyncGenerator<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 180_000);
    try {
      const res = await this.postWithRetry(
        {
          model: this.config.model,
          messages: input.messages,
          temperature: 0.3,
          stream: true,
        },
        controller.signal,
      );
      if (!res.body) {
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
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
            };
            // 只取正文：推理模型的 reasoning_content 不进回答、不进 TTS
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
