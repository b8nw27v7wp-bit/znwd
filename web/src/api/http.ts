/**
 * HTTP 基建与公共端点。
 *
 * 这一层管四件事：API 前缀（VITE_API_BASE_URL）、请求超时与 abort 传播、
 * 错误翻译（safeError：把后端 JSON 里的 message/error 变成可读文案）、
 * 以及不带口令的公共端点（health/zones/suggestions/feedback/sessions）。
 *
 * 管理面（admin.ts）、流式（stream.ts）、语音（speech.ts）都建在这套原语上，
 * 所以超时/中止语义在全部请求里是一致的。
 */

import type { HealthInfo, Suggestion, ZoneInfo } from './types';

export const json = { 'content-type': 'application/json' };
const configuredApiBase = String(import.meta.env.VITE_API_BASE_URL ?? '')
  .trim()
  .replace(/\/+$/, '');

export function apiUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return configuredApiBase ? `${configuredApiBase}${suffix}` : suffix;
}

export function newSessionId(): string {
  const cryptoApi = (globalThis as typeof globalThis & {
    crypto?: { randomUUID?: () => string; getRandomValues?: (array: Uint8Array) => Uint8Array };
  }).crypto;
  if (cryptoApi?.randomUUID) {
    return `kiosk-${cryptoApi.randomUUID()}`;
  }
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return `kiosk-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
  }
  return `kiosk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- 错误判定与中止传播原语 ----------

export function isNamedError(value: unknown): value is Error {
  if (value instanceof Error) return true;
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { name?: unknown; message?: unknown };
  return typeof candidate.name === 'string' && typeof candidate.message === 'string';
}

export function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError',
  );
}

export function isTimeoutError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: unknown }).name === 'TimeoutError',
  );
}

export function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 信号被中止时该抛什么：外部给了 reason（含超时错误）就原样抛，否则补一个 AbortError */
export function streamAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (isNamedError(reason)) return reason;
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

/** 让一个可等待值跟着 signal 一起失败：中止先到就 reject，先完成就照常落定 */
export function awaitWithAbort<T>(promise: PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  const pending = Promise.resolve(promise);
  if (signal.aborted) {
    void pending.catch(() => {});
    return Promise.reject(streamAbortError(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(streamAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/** 普通请求的超时壳：到点 abort（reason 是 TimeoutError），cleanup 负责撤定时器与外部监听 */
export function requestTimeout(signal: AbortSignal | undefined, ms: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(signal?.reason);
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError('请求超时')), ms);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** 后端失败体里的可读文案（message/error）；没有就退回状态码。超时/中止原样上抛，不吞 */
export async function safeError(res: Response, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw streamAbortError(signal);
  try {
    const body = (await (signal ? awaitWithAbort(res.json(), signal) : res.json())) as {
      message?: unknown;
      error?: unknown;
    };
    if (body && typeof body === 'object') {
      if (typeof body.message === 'string' && body.message) return body.message;
      if (typeof body.error === 'string' && body.error) return body.error;
    }
    return `请求失败（${res.status}）`;
  } catch (error) {
    if (signal?.aborted) throw streamAbortError(signal);
    if (isAbortError(error) || isTimeoutError(error)) throw error;
    return `请求失败（${res.status}）`;
  }
}

// ---------- 公共端点（不带口令；管理面在 admin.ts） ----------

export async function fetchHealth(): Promise<HealthInfo> {
  const timeout = requestTimeout(undefined, 10_000);
  try {
    const res = await awaitWithAbort(fetch(apiUrl('/api/health'), { signal: timeout.signal }), timeout.signal);
    if (!res.ok) throw new Error(`health ${res.status}`);
    return (await awaitWithAbort(res.json(), timeout.signal)) as HealthInfo;
  } finally {
    timeout.cleanup();
  }
}

export async function fetchZones(): Promise<{ zones: ZoneInfo[] }> {
  const timeout = requestTimeout(undefined, 10_000);
  try {
    const res = await awaitWithAbort(fetch(apiUrl('/api/zones'), { signal: timeout.signal }), timeout.signal);
    if (!res.ok) throw new Error(`zones ${res.status}`);
    return (await awaitWithAbort(res.json(), timeout.signal)) as { zones: ZoneInfo[] };
  } finally {
    timeout.cleanup();
  }
}

export async function fetchSuggestions(zone?: string | null): Promise<Suggestion[]> {
  const url = apiUrl(zone ? `/api/suggestions?zone=${encodeURIComponent(zone)}` : '/api/suggestions');
  const timeout = requestTimeout(undefined, 10_000);
  try {
    const res = await awaitWithAbort(fetch(url, { signal: timeout.signal }), timeout.signal);
    if (!res.ok) throw new Error(`suggestions ${res.status}`);
    const data = (await awaitWithAbort(res.json(), timeout.signal)) as { items?: unknown[] };
    // 兜一层：万一后端将来改成对象数组，这里也不会渲染出空白按钮
    return (data.items ?? [])
      .map((item) => (typeof item === 'string' ? item : ((item as { question?: string }).question ?? '')))
      .filter((question) => question.trim().length > 0);
  } finally {
    timeout.cleanup();
  }
}

export async function sendFeedback(payload: {
  sessionId: string | null;
  rating: 'up' | 'down';
  question?: string;
  comment?: string;
}): Promise<void> {
  const timeout = requestTimeout(undefined, 15_000);
  try {
    const res = await awaitWithAbort(
      fetch(apiUrl('/api/feedback'), {
        method: 'POST', headers: json, body: JSON.stringify(payload), signal: timeout.signal,
      }),
      timeout.signal,
    );
    if (!res.ok) throw new Error(await safeError(res, timeout.signal));
  } finally {
    timeout.cleanup();
  }
}

/**
 * 清掉服务端这个会话的上下文（换人用）。
 *
 * 带令牌是必须的：服务端对下发过令牌的会话，GET/DELETE 不带或不匹配一律回 404，
 * 于是「换人清上下文」会静默失败——上一轮的对话还留在服务端。
 * 令牌为空时不带头（从未下发过令牌的老会话按设计仍然放行）。
 */
export async function resetSession(sessionId: string, token?: string | null): Promise<void> {
  const timeout = requestTimeout(undefined, 10_000);
  try {
    const headers: Record<string, string> = {};
    if (token) headers['x-session-token'] = token;
    const res = await awaitWithAbort(
      fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}`), {
        method: 'DELETE', headers, signal: timeout.signal,
      }),
      timeout.signal,
    );
    if (!res.ok) throw new Error(await safeError(res, timeout.signal));
  } finally {
    timeout.cleanup();
  }
}
