/**
 * 后端接口封装。
 *
 * 契约与 Spring Boot 后端一一对应（见 docs/api.md）：
 *   POST /api/chat         非流式
 *   POST /api/chat/stream  SSE：meta → delta* → done
 *   GET  /api/suggestions  推荐问题（?zone=）
 *   GET  /api/zones        展区与展项
 *   POST /api/feedback     点赞/点踩
 *   GET  /api/health       运行状态（含 storageAvailable，数据库掉了要能看出来）
 */

export type Role = 'user' | 'assistant';

export interface Source {
  title: string;
  snippet: string;
  score: number;
  sourcePath: string;
  zone?: string | null;
  zoneTitle?: string | null;
  vectorScore?: number | null;
  keywordScore?: number | null;
}

export interface RewriteInfo {
  rewritten: boolean;
  reason: 'none' | 'no_history' | 'prev_weak' | 'ellipsis_merged';
  carriedTokens?: string[];
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface ChatMeta {
  sessionId?: string | null;
  mode: 'rag' | 'llm_only';
  provider: string;
  retrieval: 'hybrid' | 'keyword';
  noHit: boolean;
  cached: boolean;
  sources: Source[];
  rewrite?: RewriteInfo | null;
}

export interface ChatDone extends ChatMeta {
  answer: string;
  latencyMs: number;
  usage?: Usage | null;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  pending?: boolean;
  meta?: ChatMeta | null;
  latencyMs?: number;
  error?: string | null;
}

export interface ZoneInfo {
  id: string;
  title?: string;
  dir?: string;
  aliases?: string[];
  suggestions?: string[];
}

/** 推荐问题就是一行文字（后端 /api/suggestions 的 items 是字符串数组，与旧契约一致） */
export type Suggestion = string;

export interface HealthInfo {
  ok: boolean;
  version?: string;
  knowledgeChunks: number;
  llmProvider: string;
  embedding: string;
  retrieval: string;
  storage: string;
  storageAvailable: boolean;
  activeSessions: number;
  minRelevanceScore: number;
  uptimeSec: number;
}

const json = { 'content-type': 'application/json' };

export function newSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `kiosk-${Date.now().toString(36)}-${rand}`;
}

export async function fetchHealth(): Promise<HealthInfo> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`health ${res.status}`);
  return (await res.json()) as HealthInfo;
}

export async function fetchZones(): Promise<{ zones: ZoneInfo[] }> {
  const res = await fetch('/api/zones');
  if (!res.ok) throw new Error(`zones ${res.status}`);
  return (await res.json()) as { zones: ZoneInfo[] };
}

export async function fetchSuggestions(zone?: string | null): Promise<Suggestion[]> {
  const url = zone ? `/api/suggestions?zone=${encodeURIComponent(zone)}` : '/api/suggestions';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`suggestions ${res.status}`);
  const data = (await res.json()) as { items?: unknown[] };
  // 兜一层：万一后端将来改成对象数组，这里也不会渲染出空白按钮
  return (data.items ?? [])
    .map((item) => (typeof item === 'string' ? item : ((item as { question?: string }).question ?? '')))
    .filter((question) => question.trim().length > 0);
}

export async function sendFeedback(payload: {
  sessionId: string | null;
  rating: 'up' | 'down';
  question?: string;
  comment?: string;
}): Promise<void> {
  await fetch('/api/feedback', { method: 'POST', headers: json, body: JSON.stringify(payload) });
}

export async function resetSession(sessionId: string): Promise<void> {
  await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

export interface StreamHandlers {
  onMeta: (meta: ChatMeta) => void;
  onDelta: (text: string) => void;
  onDone: (done: ChatDone) => void;
}

/**
 * 流式问答：POST + fetch 流式读取（不用 EventSource —— 它只支持 GET，问题在 body 里）。
 * 逐块解析 SSE 帧，按 event 名分发。
 */
export async function streamChat(
  message: string,
  sessionId: string | null,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { ...json, accept: 'text/event-stream' },
    body: JSON.stringify({ message, sessionId }),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await safeError(res);
    throw new Error(detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 帧以空行分隔；注释帧（心跳 :ping）直接丢弃
    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      dispatchFrame(frame, handlers);
      sep = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) dispatchFrame(buffer, handlers);
}

function dispatchFrame(frame: string, handlers: StreamHandlers): void {
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return;
  const payload = dataLines.join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  if (event === 'meta') handlers.onMeta(parsed as ChatMeta);
  else if (event === 'delta') handlers.onDelta((parsed as { text?: string }).text ?? '');
  else if (event === 'done') handlers.onDone(parsed as ChatDone);
  else if (event === 'error') {
    const err = parsed as { message?: string };
    throw new Error(err.message || '服务内部错误');
  }
}

async function safeError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message || body.error || `请求失败（${res.status}）`;
  } catch {
    return `请求失败（${res.status}）`;
  }
}
