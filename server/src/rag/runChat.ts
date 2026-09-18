import type { ChatModel } from '../llm/types.js';
import type { HybridRetriever } from '../knowledge/hybridRetriever.js';
import type { SessionStore } from '../session/store.js';
import type { Analytics } from '../analytics/stats.js';
import { LruCache, JsonlStore, answerCacheKey, type CachedAnswer } from '../http/cache.js';
import { messageLogFields, type LogMessageMode } from '../http/errors.js';
import { answerQuestion, streamAnswer, type RagSource } from './pipeline.js';

export interface RunChatDeps {
  retriever: HybridRetriever;
  model: ChatModel;
  sessions: SessionStore;
  analytics: Analytics;
  answerCache: LruCache<CachedAnswer>;
  logStore: JsonlStore;
}

export interface RunChatInput {
  message: string;
  sessionId?: string;
  started?: number;
}

export interface RunChatResponse {
  answer: string;
  sources: unknown[];
  mode: string;
  provider: string;
  retrieval: string;
  sessionId: string | null;
  latencyMs: number;
  cached: boolean;
}

function logMode(deps: RunChatDeps): LogMessageMode {
  return deps.logStore.messageMode ?? 'hash';
}

function writeChatLog(
  deps: RunChatDeps,
  fields: {
    mode: string;
    provider: string;
    sessionId?: string;
    message: string;
    answerPreview: string;
    sources?: number;
    latencyMs: number;
    error?: string;
  },
): void {
  const { message, ...rest } = fields;
  const preview = messageLogFields(message, logMode(deps));
  deps.logStore.append({
    type: 'chat',
    ...rest,
    ...preview,
    answerPreview: fields.answerPreview,
  });
}

/** 非流式完整链路：缓存 / 检索+LLM / 会话 / 统计 / 日志 */
export async function runChat(deps: RunChatDeps, input: RunChatInput): Promise<RunChatResponse> {
  const { message, sessionId } = input;
  const started = input.started ?? Date.now();
  const key = answerCacheKey(message, deps.model.name);
  const history = deps.sessions.history(sessionId);
  const hit = deps.answerCache.get(key);

  if (hit && history.length === 0) {
    deps.sessions.append(sessionId, message, hit.answer);
    const preview = messageLogFields(message, logMode(deps));
    deps.analytics.logChat({
      at: started,
      sessionId: sessionId ?? null,
      mode: hit.mode as 'rag' | 'llm_only',
      provider: hit.provider,
      messagePreview: preview.messagePreview ?? message.slice(0, 80),
      answerPreview: hit.answer.slice(0, 80),
      latencyMs: 0,
    });
    writeChatLog(deps, {
      mode: hit.mode,
      provider: hit.provider,
      sessionId,
      message,
      answerPreview: hit.answer.slice(0, 200),
      latencyMs: 0,
    });
    return {
      answer: hit.answer,
      sources: hit.sources,
      mode: hit.mode,
      provider: hit.provider,
      retrieval: hit.retrieval,
      sessionId: sessionId ?? null,
      latencyMs: 0,
      cached: true,
    };
  }

  const result = await answerQuestion(deps.retriever, deps.model, message, { history });
  deps.sessions.append(sessionId, message, result.answer);

  const payload: CachedAnswer = {
    answer: result.answer,
    sources: result.sources,
    mode: result.mode,
    provider: result.provider,
    retrieval: result.retrieval,
    cached: false,
  };
  if (history.length === 0) deps.answerCache.set(key, payload);

  const latencyMs = Date.now() - started;
  const preview = messageLogFields(message, logMode(deps));
  deps.analytics.logChat({
    at: started,
    sessionId: sessionId ?? null,
    mode: result.mode,
    provider: result.provider,
    messagePreview: preview.messagePreview ?? message.slice(0, 80),
    answerPreview: result.answer.slice(0, 80),
    latencyMs,
  });
  writeChatLog(deps, {
    mode: result.mode,
    provider: result.provider,
    sessionId,
    message,
    answerPreview: result.answer.slice(0, 200),
    sources: result.sources?.length ?? 0,
    latencyMs,
  });

  return {
    answer: result.answer,
    sources: result.sources,
    mode: result.mode,
    provider: result.provider,
    retrieval: result.retrieval,
    sessionId: sessionId ?? null,
    latencyMs,
    cached: false,
  };
}

export type StreamChatEvent =
  | { type: 'meta'; sources: RagSource[]; mode: 'rag' | 'llm_only'; provider: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; full: string; sources: unknown[]; mode: 'rag' | 'llm_only'; latencyMs: number };

/** 与 runChat 共用会话/日志/统计；中间 yield 流事件 */
export async function* streamChat(deps: RunChatDeps, input: RunChatInput): AsyncGenerator<StreamChatEvent> {
  const { message, sessionId } = input;
  const started = input.started ?? Date.now();
  const history = deps.sessions.history(sessionId);
  let full = '';
  let mode: 'rag' | 'llm_only' = 'llm_only';
  let sources: unknown[] = [];
  let provider = deps.model.name;

  for await (const ev of streamAnswer(deps.retriever, deps.model, message, { history })) {
    if (ev.type === 'meta') {
      mode = ev.mode;
      sources = ev.sources;
      provider = ev.provider;
      yield ev;
    } else if (ev.type === 'delta') {
      yield ev;
    } else if (ev.type === 'done') {
      full = ev.full;
    }
  }

  const latencyMs = Date.now() - started;
  deps.sessions.append(sessionId, message, full);
  const preview = messageLogFields(message, logMode(deps));
  deps.analytics.logChat({
    at: started,
    sessionId: sessionId ?? null,
    mode,
    provider,
    messagePreview: preview.messagePreview ?? message.slice(0, 80),
    answerPreview: full.slice(0, 80),
    latencyMs,
  });
  writeChatLog(deps, {
    mode,
    provider,
    sessionId,
    message,
    answerPreview: full.slice(0, 200),
    sources: Array.isArray(sources) ? sources.length : 0,
    latencyMs,
  });

  yield { type: 'done', full, sources, mode, latencyMs };
}
