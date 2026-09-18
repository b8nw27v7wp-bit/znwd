import type { FastifyInstance, FastifyRequest } from 'fastify';
import { answerQuestion, streamAnswer } from '../rag/pipeline.js';
import type { ChatModel } from '../llm/types.js';
import type { HybridRetriever } from '../knowledge/hybridRetriever.js';
import type { SessionStore } from '../session/store.js';
import type { Analytics } from '../analytics/stats.js';
import type { RateLimiter } from '../http/rateLimit.js';
import { suggestionsForZone } from '../knowledge/suggestions.js';
import { loadZonesMeta } from '../knowledge/loader.js';
import type { ZonesMeta } from '../knowledge/loader.js';
import { LruCache, JsonlStore, adminOk, answerCacheKey, type CachedAnswer } from '../http/cache.js';

interface RouteDeps {
  retriever: HybridRetriever;
  model: ChatModel;
  sessions: SessionStore;
  analytics: Analytics;
  chatLimiter: RateLimiter;
  knowledgeDir: string;
  adminToken?: string;
  answerCache: LruCache<CachedAnswer>;
  logStore: JsonlStore;
}

function clientIp(req: FastifyRequest): string {
  return req.ip || 'unknown';
}

function sanitizeSessionId(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 64);
  return undefined;
}

export function registerChatRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const readZones = async (): Promise<ZonesMeta> => loadZonesMeta(deps.knowledgeDir);

  app.get<{ Querystring: { zone?: string } }>('/api/suggestions', async (req) => {
    const meta = await readZones();
    return { items: suggestionsForZone(meta, req.query.zone), zone: req.query.zone ?? null };
  });

  app.get('/api/zones', async () => readZones());

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (req, reply) => {
    const id = sanitizeSessionId(req.params.sessionId);
    if (!id) return reply.code(400).send({ error: 'sessionId is required' });
    const data = deps.sessions.peek(id);
    if (!data) return reply.code(404).send({ error: 'session not found or expired' });
    return { sessionId: id, messages: data.messages, lastActive: data.lastActive };
  });

  app.delete<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (req, reply) => {
    const id = sanitizeSessionId(req.params.sessionId);
    if (!id) return reply.code(400).send({ error: 'sessionId is required' });
    return { ok: deps.sessions.reset(id), sessionId: id };
  });

  app.post<{ Body: { sessionId?: string; rating?: string; comment?: string } }>(
    '/api/feedback',
    async (req, reply) => {
      const rating = req.body?.rating;
      if (rating !== 'up' && rating !== 'down') {
        return reply.code(400).send({ error: "rating must be 'up' or 'down'" });
      }
      const sessionId = sanitizeSessionId(req.body?.sessionId);
      const comment =
        typeof req.body?.comment === 'string' ? req.body.comment.slice(0, 500) : undefined;
      const item = {
        at: Date.now(),
        sessionId: sessionId ?? null,
        rating: rating as 'up' | 'down',
        comment,
      };
      deps.analytics.logFeedback(item);
      deps.logStore.append({ type: 'feedback', ...item });
      return { ok: true };
    },
  );

  app.get('/api/stats', async (req, reply) => {
    if (!adminOk(req.headers.authorization, deps.adminToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return deps.analytics.stats(deps.sessions.count());
  });

  app.get('/api/openapi.json', async () => ({
    openapi: '3.0.0',
    info: { title: 'Virtual Hostess API', version: '0.6.0' },
    servers: [{ url: '/' }],
    paths: {
      '/api/health': { get: { summary: 'Health' } },
      '/api/chat': { post: { summary: 'Chat' } },
      '/api/chat/stream': { post: { summary: 'Chat SSE' } },
      '/api/suggestions': { get: { summary: 'Suggestions' } },
      '/api/zones': { get: { summary: 'Zones' } },
      '/api/knowledge/list': { get: { summary: 'Knowledge list' } },
      '/api/knowledge/reload': { post: { summary: 'Reload knowledge' } },
    },
  }));

  /** SSE 流式问答 */
  app.post<{ Body: { message?: string; sessionId?: string } }>(
    '/api/chat/stream',
    async (req, reply) => {
      const wait = deps.chatLimiter.allow(clientIp(req));
      if (wait !== null) {
        return reply.code(429).send({ error: 'too many requests', retryAfterSec: wait });
      }
      const message = (req.body?.message ?? '').trim().slice(0, 2000);
      if (!message) return reply.code(400).send({ error: 'message is required' });
      const sessionId = sanitizeSessionId(req.body?.sessionId);
      const started = Date.now();

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const history = deps.sessions.history(sessionId);
        let full = '';
        let mode: 'rag' | 'llm_only' = 'llm_only';
        let sources: unknown[] = [];

        for await (const ev of streamAnswer(deps.retriever, deps.model, message, { history })) {
          if (ev.type === 'meta') {
            mode = ev.mode;
            sources = ev.sources;
            send('meta', { mode: ev.mode, sources: ev.sources, provider: ev.provider, sessionId });
          } else if (ev.type === 'delta') {
            send('delta', { text: ev.text });
          } else if (ev.type === 'done') {
            full = ev.full;
          }
        }

        deps.sessions.append(sessionId, message, full);
        const latencyMs = Date.now() - started;
        deps.analytics.logChat({
          at: started,
          sessionId: sessionId ?? null,
          mode,
          provider: deps.model.name,
          messagePreview: message.slice(0, 80),
          answerPreview: full.slice(0, 80),
          latencyMs,
        });
        deps.logStore.append({
          type: 'chat',
          mode,
          provider: deps.model.name,
          sessionId,
          message,
          answerPreview: full.slice(0, 200),
          latencyMs,
        });
        send('done', { latencyMs, answer: full, sources, mode });
      } catch (err) {
        send('error', { error: err instanceof Error ? err.message : 'stream failed' });
      }
      reply.raw.end();
      return reply;
    },
  );

  app.post<{ Body: { message?: string; sessionId?: string } }>('/api/chat', async (req, reply) => {
    const wait = deps.chatLimiter.allow(clientIp(req));
    if (wait !== null) {
      return reply.code(429).send({ error: 'too many requests', retryAfterSec: wait });
    }

    const message = (req.body?.message ?? '').trim().slice(0, 2000);
    if (!message) return reply.code(400).send({ error: 'message is required' });
    const sessionId = sanitizeSessionId(req.body?.sessionId);
    const started = Date.now();
    const key = answerCacheKey(message, deps.model.name);

    try {
      const history = deps.sessions.history(sessionId);
      const hit = deps.answerCache.get(key);
      // 有多轮历史时跳过缓存，保证上下文；命中时仍写入会话，否则后续追问丢上下文
      if (hit && history.length === 0) {
        deps.sessions.append(sessionId, message, hit.answer);
        deps.analytics.logChat({
          at: started,
          sessionId: sessionId ?? null,
          mode: hit.mode as 'rag' | 'llm_only',
          provider: hit.provider,
          messagePreview: message.slice(0, 80),
          answerPreview: hit.answer.slice(0, 80),
          latencyMs: 0,
        });
        return { ...hit, cached: true, sessionId: sessionId ?? null, latencyMs: 0 };
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
      deps.analytics.logChat({
        at: started,
        sessionId: sessionId ?? null,
        mode: result.mode,
        provider: result.provider,
        messagePreview: message.slice(0, 80),
        answerPreview: result.answer.slice(0, 80),
        latencyMs,
      });
      deps.logStore.append({
        type: 'chat',
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
    } catch (err) {
      req.log.error(err);
      deps.analytics.logChat({
        at: started,
        sessionId: sessionId ?? null,
        mode: 'llm_only',
        provider: deps.model.name,
        messagePreview: message.slice(0, 80),
        answerPreview: '',
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : 'chat failed',
      });
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'chat failed' });
    }
  });
}
