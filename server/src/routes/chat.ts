import type { FastifyInstance, FastifyRequest } from 'fastify';
import { answerQuestion } from '../rag/pipeline.js';
import type { ChatModel } from '../llm/types.js';
import type { HybridRetriever } from '../knowledge/hybridRetriever.js';
import type { SessionStore } from '../session/store.js';
import type { Analytics } from '../analytics/stats.js';
import type { RateLimiter } from '../http/rateLimit.js';
import { suggestionsForZone } from '../knowledge/suggestions.js';
import { loadZonesMeta } from '../knowledge/loader.js';
import type { ZonesMeta } from '../knowledge/loader.js';

interface RouteDeps {
  retriever: HybridRetriever;
  model: ChatModel;
  sessions: SessionStore;
  analytics: Analytics;
  chatLimiter: RateLimiter;
  knowledgeDir: string;
}

function clientIp(req: FastifyRequest): string {
  return req.ip || 'unknown';
}

function sanitizeSessionId(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim().slice(0, 64);
  }
  return undefined;
}

export function registerChatRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const readZones = async (): Promise<ZonesMeta> => loadZonesMeta(deps.knowledgeDir);

  app.get<{ Querystring: { zone?: string } }>('/api/suggestions', async (req) => {
    const meta = await readZones();
    return {
      items: suggestionsForZone(meta, req.query.zone),
      zone: req.query.zone ?? null,
    };
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
    const ok = deps.sessions.reset(id);
    return { ok, sessionId: id };
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
      deps.analytics.logFeedback({
        at: Date.now(),
        sessionId: sessionId ?? null,
        rating,
        comment,
      });
      return { ok: true };
    },
  );

  app.get('/api/stats', async () => deps.analytics.stats(deps.sessions.count()));

  app.post<{ Body: { message?: string; sessionId?: string } }>('/api/chat', async (req, reply) => {
    const wait = deps.chatLimiter.allow(clientIp(req));
    if (wait !== null) {
      return reply.code(429).send({ error: 'too many requests', retryAfterSec: wait });
    }

    const message = (req.body?.message ?? '').trim().slice(0, 2000);
    if (!message) {
      return reply.code(400).send({ error: 'message is required' });
    }
    const sessionId = sanitizeSessionId(req.body?.sessionId);
    const started = Date.now();

    try {
      const history = deps.sessions.history(sessionId);
      const result = await answerQuestion(deps.retriever, deps.model, message, { history });
      deps.sessions.append(sessionId, message, result.answer);

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

      return {
        answer: result.answer,
        sources: result.sources,
        mode: result.mode,
        provider: result.provider,
        retrieval: result.retrieval,
        sessionId: sessionId ?? null,
        latencyMs,
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
