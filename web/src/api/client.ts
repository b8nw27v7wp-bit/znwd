export interface ChatSource {
  title: string;
  snippet: string;
  score: number;
  sourcePath: string;
  zone?: string;
  zoneTitle?: string;
}

export interface ChatResponse {
  answer: string;
  sources: ChatSource[];
  mode: 'rag' | 'llm_only';
  provider: string;
  retrieval?: 'hybrid' | 'keyword';
  sessionId?: string | null;
  latencyMs?: number;
  cached?: boolean;
  /** 知识库未覆盖（相关性闸门拦截） */
  noHit?: boolean;
}

export interface StreamHandlers {
  onMeta?: (meta: { mode: string; sources: ChatSource[]; provider: string; noHit?: boolean }) => void;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

function parseSseChunk(buffer: string): { events: Array<{ event: string; data: unknown }>; rest: string } {
  const events: Array<{ event: string; data: unknown }> = [];
  let rest = buffer;
  const parts = rest.split('\n\n');
  rest = parts.pop() ?? '';
  for (const part of parts) {
    const lines = part.split('\n');
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    try {
      events.push({ event, data: JSON.parse(dataLines.join('\n')) });
    } catch {
      // skip malformed
    }
  }
  return { events, rest };
}

function errMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const o = body as { message?: string; error?: string };
    if (o.message) return o.message;
    if (o.error) return o.error;
  }
  return `请求失败 (${status})`;
}

export async function sendChat(
  message: string,
  sessionId?: string,
): Promise<ChatResponse> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, sessionId }),
  });

  if (!res.ok) {
    let detail = `请求失败 (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string; message?: string };
      detail = errMessage(res.status, data);
    } catch {
      // ignore
    }
    throw new Error(detail);
  }

  return (await res.json()) as ChatResponse;
}

/**
 * SSE 流式：meta → delta* → done。
 * 网络/协议失败时 throw，由调用方回退 sendChat。
 */
export async function sendChatStream(
  message: string,
  sessionId: string | undefined,
  handlers: StreamHandlers = {},
): Promise<ChatResponse> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ message, sessionId }),
    signal: handlers.signal,
  });

  if (!res.ok || !res.body) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => null);
    }
    throw new Error(errMessage(res.status, body));
  }

  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream')) {
    throw new Error('stream unsupported');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let mode: 'rag' | 'llm_only' = 'llm_only';
  let sources: ChatSource[] = [];
  let provider = '';
  let answer = '';
  let gotDone = false;
  let noHit = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseChunk(buffer);
    buffer = rest;
    for (const ev of events) {
      if (ev.event === 'meta') {
        const d = ev.data as {
          mode?: 'rag' | 'llm_only';
          sources?: ChatSource[];
          provider?: string;
          noHit?: boolean;
        };
        mode = d.mode ?? mode;
        sources = d.sources ?? [];
        provider = d.provider ?? provider;
        if (typeof d.noHit === 'boolean') noHit = d.noHit;
        handlers.onMeta?.({ mode, sources, provider, noHit });
      } else if (ev.event === 'delta') {
        const d = ev.data as { text?: string };
        if (d.text) {
          answer += d.text;
          handlers.onDelta?.(d.text);
        }
      } else if (ev.event === 'done') {
        const d = ev.data as {
          answer?: string;
          sources?: ChatSource[];
          mode?: 'rag' | 'llm_only';
          latencyMs?: number;
          noHit?: boolean;
        };
        if (typeof d.answer === 'string') answer = d.answer;
        if (d.sources) sources = d.sources;
        if (d.mode) mode = d.mode;
        if (typeof d.noHit === 'boolean') noHit = d.noHit;
        gotDone = true;
        return {
          answer,
          sources,
          mode,
          provider,
          sessionId: sessionId ?? null,
          latencyMs: d.latencyMs,
          noHit,
        };
      } else if (ev.event === 'error') {
        const d = ev.data as { message?: string; error?: string };
        throw new Error(errMessage(500, d));
      }
    }
  }

  // 未收到 done（提前断线/截断）→ 抛错，由调用方回退 POST /api/chat
  if (!gotDone) {
    throw new Error(answer ? 'stream incomplete' : 'stream ended without answer');
  }
  return { answer, sources, mode, provider, sessionId: sessionId ?? null };
}

export async function fetchSuggestions(zone?: string): Promise<string[]> {
  const qs = zone ? `?zone=${encodeURIComponent(zone)}` : '';
  const res = await fetch(`/api/suggestions${qs}`);
  if (!res.ok) throw new Error(`suggestions ${res.status}`);
  const data = (await res.json()) as { items?: string[] };
  return data.items ?? [];
}

/** 访客反馈：服务端在未带 question 时取会话里最后一条提问 */
export async function sendFeedback(input: {
  rating: 'up' | 'down';
  sessionId?: string;
  question?: string;
}): Promise<void> {
  const res = await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`feedback ${res.status}`);
}
