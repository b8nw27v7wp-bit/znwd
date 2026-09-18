import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { runChat, streamChat, type RunChatDeps } from '../rag/runChat.js';
import type { HybridRetriever } from '../knowledge/hybridRetriever.js';
import { suggestionsForZone } from '../knowledge/suggestions.js';
import { loadZonesMeta } from '../knowledge/loader.js';
import type { ZonesMeta } from '../knowledge/loader.js';
import { adminOk, type CachedAnswer, type LruCache, type JsonlStore } from '../http/cache.js';
import { errorPayload, messageLogFields } from '../http/errors.js';
import type { ChatModel } from '../llm/types.js';
import type { SessionStore } from '../session/store.js';
import type { Analytics } from '../analytics/stats.js';
import type { RateLimiter } from '../http/rateLimit.js';

interface RouteDeps extends RunChatDeps {
  retriever: HybridRetriever;
  model: ChatModel;
  sessions: SessionStore;
  analytics: Analytics;
  chatLimiter: RateLimiter;
  knowledgeDir: string;
  adminToken?: string;
  adminTokenRequired: boolean;
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

function requestId(req: FastifyRequest): string {
  return String(req.id ?? '');
}

function denyAdmin(req: FastifyRequest, reply: FastifyReply, required: boolean) {
  req.log.error(
    { requestId: requestId(req), adminTokenRequired: required },
    'admin route rejected: token missing or invalid',
  );
  return reply
    .code(401)
    .send(errorPayload('unauthorized', 'unauthorized', requestId(req)));
}

export function registerChatRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const readZones = async (): Promise<ZonesMeta> => loadZonesMeta(deps.knowledgeDir);
  const adminOpts = { requireToken: deps.adminTokenRequired };

  app.get<{ Querystring: { zone?: string } }>('/api/suggestions', async (req) => {
    const meta = await readZones();
    return { items: suggestionsForZone(meta, req.query.zone), zone: req.query.zone ?? null };
  });

  app.get('/api/zones', async () => readZones());

  app.get<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (req, reply) => {
    const id = sanitizeSessionId(req.params.sessionId);
    if (!id) {
      return reply
        .code(400)
        .send(errorPayload('validation_error', 'sessionId is required', requestId(req)));
    }
    const data = deps.sessions.peek(id);
    if (!data) {
      return reply
        .code(404)
        .send(errorPayload('not_found', 'session not found or expired', requestId(req)));
    }
    return { sessionId: id, messages: data.messages, lastActive: data.lastActive };
  });

  app.delete<{ Params: { sessionId: string } }>('/api/sessions/:sessionId', async (req, reply) => {
    const id = sanitizeSessionId(req.params.sessionId);
    if (!id) {
      return reply
        .code(400)
        .send(errorPayload('validation_error', 'sessionId is required', requestId(req)));
    }
    return { ok: deps.sessions.reset(id), sessionId: id };
  });

  app.post<{ Body: { sessionId?: string; rating?: string; comment?: string } }>(
    '/api/feedback',
    async (req, reply) => {
      const rating = req.body?.rating;
      if (rating !== 'up' && rating !== 'down') {
        return reply
          .code(400)
          .send(errorPayload('validation_error', "rating must be 'up' or 'down'", requestId(req)));
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
    if (!adminOk(req.headers.authorization, deps.adminToken, adminOpts)) {
      return denyAdmin(req, reply, deps.adminTokenRequired);
    }
    return deps.analytics.stats(deps.sessions.count());
  });

  app.get('/api/openapi.json', async () => ({
    openapi: '3.0.0',
    info: { title: 'Virtual Hostess API', version: '0.7.0' },
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

  /** SSE 流式问答（业务与 POST /api/chat 共用 streamChat/runChat） */
  app.post<{ Body: { message?: string; sessionId?: string } }>(
    '/api/chat/stream',
    async (req, reply) => {
      const rid = requestId(req);
      const wait = deps.chatLimiter.allow(clientIp(req));
      if (wait !== null) {
        return reply
          .code(429)
          .send(errorPayload('rate_limited', 'too many requests', rid, { retryAfterSec: wait }));
      }
      const message = (req.body?.message ?? '').trim().slice(0, 2000);
      if (!message) {
        return reply.code(400).send(errorPayload('validation_error', 'message is required', rid));
      }
      const sessionId = sanitizeSessionId(req.body?.sessionId);
      const started = Date.now();

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
        'x-request-id': rid,
      });
      const send = (event: string, data: unknown) => {
        reply.raw.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      };

      try {
        for await (const ev of streamChat(deps, { message, sessionId, started })) {
          if (ev.type === 'meta') {
            send('meta', {
              mode: ev.mode,
              sources: ev.sources,
              provider: ev.provider,
              sessionId,
            });
          } else if (ev.type === 'delta') {
            send('delta', { text: ev.text });
          } else if (ev.type === 'done') {
            send('done', {
              latencyMs: ev.latencyMs,
              answer: ev.full,
              sources: ev.sources,
              mode: ev.mode,
            });
          }
        }
      } catch (err) {
        req.log.error({ requestId: rid, err }, 'sse chat failed');
        send(
          'error',
          errorPayload('internal_error', '服务内部错误', rid),
        );
      }
      reply.raw.end();
      return reply;
    },
  );

  app.post<{ Body: { message?: string; sessionId?: string } }>('/api/chat', async (req, reply) => {
    const rid = requestId(req);
    const wait = deps.chatLimiter.allow(clientIp(req));
    if (wait !== null) {
      return reply
        .code(429)
        .send(errorPayload('rate_limited', 'too many requests', rid, { retryAfterSec: wait }));
    }

    const message = (req.body?.message ?? '').trim().slice(0, 2000);
    if (!message) {
      return reply.code(400).send(errorPayload('validation_error', 'message is required', rid));
    }
    const sessionId = sanitizeSessionId(req.body?.sessionId);
    const started = Date.now();

    try {
      const result = await runChat(deps, { message, sessionId, started });
      return result;
    } catch (err) {
      req.log.error({ requestId: rid, err }, 'chat failed');
      const preview = messageLogFields(message, deps.logStore.messageMode);
      deps.analytics.logChat({
        at: started,
        sessionId: sessionId ?? null,
        mode: 'llm_only',
        provider: deps.model.name,
        messagePreview: preview.messagePreview ?? message.slice(0, 80),
        answerPreview: '',
        latencyMs: Date.now() - started,
        error: 'internal_error',
      });
      return reply
        .code(500)
        .send(errorPayload('internal_error', '服务内部错误', rid));
    }
  });
}
