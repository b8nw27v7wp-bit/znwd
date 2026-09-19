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
  /** 知识库未覆盖（相关性闸门拦截） */
  noHit: boolean;
  /** 多轮指代改写（检索用查询与是否发生改写） */
  rewrite?: { rewritten: boolean; reason: string; carriedTokens: string[] };
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
    noHit?: boolean;
    retrieval?: string;
    rewritten?: boolean;
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
  const key = answerCacheKey(message, deps.model.name, deps.retriever.generation());
  const history = deps.sessions.history(sessionId);
  const hit = deps.answerCache.get(key);

  if (hit && history.length === 0) {
    const hitRetrieval = (hit.retrieval === 'hybrid' ? 'hybrid' : 'keyword') as 'hybrid' | 'keyword';
    const hitNoHit = hit.noHit ?? hit.mode !== 'rag';
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
      noHit: hitNoHit,
      retrieval: hitRetrieval,
    });
    writeChatLog(deps, {
      mode: hit.mode,
      provider: hit.provider,
      sessionId,
      message,
      answerPreview: hit.answer.slice(0, 200),
      latencyMs: 0,
      noHit: hitNoHit,
      retrieval: hitRetrieval,
    });
    return {
      answer: hit.answer,
      sources: hit.sources,
      mode: hit.mode,
      provider: hit.provider,
      retrieval: hitRetrieval,
      sessionId: sessionId ?? null,
      latencyMs: 0,
      cached: true,
      noHit: hitNoHit,
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
    noHit: result.noHit,
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
    noHit: result.noHit,
    retrieval: result.retrieval,
    rewritten: result.rewrite?.rewritten === true,
    question: result.noHit ? message : undefined,
  });
  writeChatLog(deps, {
    mode: result.mode,
    provider: result.provider,
    sessionId,
    message,
    answerPreview: result.answer.slice(0, 200),
    sources: result.sources?.length ?? 0,
    latencyMs,
    noHit: result.noHit,
    retrieval: result.retrieval,
    rewritten: result.rewrite?.rewritten === true,
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
    noHit: result.noHit,
    rewrite: result.rewrite
      ? {
          rewritten: result.rewrite.rewritten,
          reason: result.rewrite.reason,
          carriedTokens: result.rewrite.carriedTokens,
        }
      : undefined,
  };
}

export type StreamChatEvent =
  | {
      type: 'meta';
      sources: RagSource[];
      mode: 'rag' | 'llm_only';
      provider: string;
      noHit: boolean;
      retrieval: 'hybrid' | 'keyword';
      rewrite: { rewritten: boolean; reason: string; carriedTokens: string[] };
    }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      full: string;
      sources: unknown[];
      mode: 'rag' | 'llm_only';
      latencyMs: number;
      cached: boolean;
      noHit: boolean;
      retrieval: 'hybrid' | 'keyword';
    };

/**
 * 与 runChat 共用会话/日志/统计；中间 yield 流事件。
 * 与非流式一致地读写答案缓存（此前只有 POST /api/chat 会写缓存，两个入口行为不一致）。
 */
export async function* streamChat(deps: RunChatDeps, input: RunChatInput): AsyncGenerator<StreamChatEvent> {
  const { message, sessionId } = input;
  const started = input.started ?? Date.now();
  const history = deps.sessions.history(sessionId);
  const key = answerCacheKey(message, deps.model.name, deps.retriever.generation());
  const hit = deps.answerCache.get(key);

  if (hit && history.length === 0) {
    const latencyMs = Date.now() - started;
    deps.sessions.append(sessionId, message, hit.answer);
    const preview = messageLogFields(message, logMode(deps));
    const retrieval = (hit.retrieval === 'hybrid' ? 'hybrid' : 'keyword') as 'hybrid' | 'keyword';
    deps.analytics.logChat({
      at: started,
      sessionId: sessionId ?? null,
      mode: hit.mode as 'rag' | 'llm_only',
      provider: hit.provider,
      messagePreview: preview.messagePreview ?? message.slice(0, 80),
      answerPreview: hit.answer.slice(0, 80),
      latencyMs,
      noHit: hit.noHit ?? hit.mode !== 'rag',
      retrieval,
    });
    writeChatLog(deps, {
      mode: hit.mode,
      provider: hit.provider,
      sessionId,
      message,
      answerPreview: hit.answer.slice(0, 200),
      sources: Array.isArray(hit.sources) ? hit.sources.length : 0,
      latencyMs,
      noHit: hit.noHit ?? hit.mode !== 'rag',
      retrieval,
    });
    yield {
      type: 'meta',
      sources: (hit.sources ?? []) as RagSource[],
      mode: hit.mode as 'rag' | 'llm_only',
      provider: hit.provider,
      noHit: hit.noHit ?? hit.mode !== 'rag',
      retrieval,
      rewrite: { rewritten: false, reason: 'none', carriedTokens: [] },
    };
    yield { type: 'delta', text: hit.answer };
    yield {
      type: 'done',
      full: hit.answer,
      sources: hit.sources,
      mode: hit.mode as 'rag' | 'llm_only',
      latencyMs,
      cached: true,
      noHit: hit.noHit ?? hit.mode !== 'rag',
      retrieval,
    };
    return;
  }

  let full = '';
  let mode: 'rag' | 'llm_only' = 'llm_only';
  let sources: unknown[] = [];
  let provider = deps.model.name;
  let noHit = true;
  let retrieval: 'hybrid' | 'keyword' = 'keyword';
  let rewritten = false;

  for await (const ev of streamAnswer(deps.retriever, deps.model, message, { history })) {
    if (ev.type === 'meta') {
      mode = ev.mode;
      sources = ev.sources;
      provider = ev.provider;
      noHit = ev.noHit;
      retrieval = ev.diagnostics.mode;
      rewritten = ev.rewrite.rewritten;
      yield {
        type: 'meta',
        sources: ev.sources,
        mode: ev.mode,
        provider: ev.provider,
        noHit,
        retrieval,
        rewrite: ev.rewrite,
      };
    } else if (ev.type === 'delta') {
      yield ev;
    } else if (ev.type === 'done') {
      full = ev.full;
    }
  }

  const latencyMs = Date.now() - started;
  deps.sessions.append(sessionId, message, full);
  if (history.length === 0) {
    deps.answerCache.set(key, {
      answer: full,
      sources,
      mode,
      provider,
      retrieval,
      cached: false,
      noHit,
    });
  }
  const preview = messageLogFields(message, logMode(deps));
  deps.analytics.logChat({
    at: started,
    sessionId: sessionId ?? null,
    mode,
    provider,
    messagePreview: preview.messagePreview ?? message.slice(0, 80),
    answerPreview: full.slice(0, 80),
    latencyMs,
    noHit,
    retrieval,
    rewritten,
    question: noHit ? message : undefined,
  });
  writeChatLog(deps, {
    mode,
    provider,
    sessionId,
    message,
    answerPreview: full.slice(0, 200),
    sources: Array.isArray(sources) ? sources.length : 0,
    latencyMs,
    noHit,
    retrieval,
    rewritten,
  });

  yield { type: 'done', full, sources, mode, latencyMs, cached: false, noHit, retrieval };
}
