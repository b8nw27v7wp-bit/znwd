import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { runChat, streamChat, type RunChatDeps } from '../rag/runChat.js';
import type { HybridRetriever } from '../knowledge/hybridRetriever.js';
import { suggestionsForZone } from '../knowledge/suggestions.js';
import { loadZonesMeta } from '../knowledge/loader.js';
import type { ZonesMeta } from '../knowledge/loader.js';
import { adminOk, type CachedAnswer, type LruCache, type JsonlStore } from '../http/cache.js';
import { errorPayload, messageLogFields } from '../http/errors.js';
import { parseChatInput, normalizeSessionId, validationMessage, MESSAGE_MAX_CHARS } from '../http/request.js';
import { corsHeadersFor } from '../http/cors.js';
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
  corsOrigins: string[];
  minRelevanceScore: number;
}

function clientIp(req: FastifyRequest): string {
  return req.ip || 'unknown';
}

function requestId(req: FastifyRequest): string {
  return String(req.id ?? '');
}

/** 反馈未带 question 时从会话里取最后一条用户提问：保证运营看到的是真实问题 */
function lastUserQuestion(sessions: SessionStore, sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  const data = sessions.peek(sessionId);
  if (!data) return undefined;
  for (let i = data.messages.length - 1; i >= 0; i--) {
    const m = data.messages[i];
    if (m.role === 'user' && m.content.trim()) return m.content.trim().slice(0, 200);
  }
  return undefined;
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
    const id = normalizeSessionId(req.params.sessionId);
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
    const id = normalizeSessionId(req.params.sessionId);
    if (!id) {
      return reply
        .code(400)
        .send(errorPayload('validation_error', 'sessionId is required', requestId(req)));
    }
    return { ok: deps.sessions.reset(id), sessionId: id };
  });

  app.post<{ Body: { sessionId?: string; rating?: string; comment?: string; question?: string } }>(
    '/api/feedback',
    async (req, reply) => {
      const rating = req.body?.rating;
      if (rating !== 'up' && rating !== 'down') {
        return reply
          .code(400)
          .send(errorPayload('validation_error', "rating must be 'up' or 'down'", requestId(req)));
      }
      const sessionId = normalizeSessionId(req.body?.sessionId);
      const comment =
        typeof req.body?.comment === 'string' ? req.body.comment.slice(0, 500) : undefined;
      const question =
        typeof req.body?.question === 'string' && req.body.question.trim()
          ? req.body.question.trim().slice(0, 200)
          : lastUserQuestion(deps.sessions, sessionId);
      const item = {
        at: Date.now(),
        sessionId: sessionId ?? null,
        rating: rating as 'up' | 'down',
        comment,
        question,
      };
      deps.analytics.logFeedback(item);
      deps.logStore.append({ type: 'feedback', ...item });
      return { ok: true };
    },
  );

  /** P3：反馈统计；`?format=csv` 导出 */
  app.get<{ Querystring: { format?: string } }>('/api/admin/feedback-stats', async (req, reply) => {
    if (!adminOk(req.headers.authorization, deps.adminToken, adminOpts)) {
      return denyAdmin(req, reply, deps.adminTokenRequired);
    }
    const format = (req.query.format || 'json').toLowerCase();
    if (format === 'csv') {
      const csv = deps.analytics.feedbackCsv();
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="feedback.csv"')
        .send(csv);
    }
    return deps.analytics.feedbackStats();
  });

  app.get('/api/stats', async (req, reply) => {
    if (!adminOk(req.headers.authorization, deps.adminToken, adminOpts)) {
      return denyAdmin(req, reply, deps.adminTokenRequired);
    }
    return deps.analytics.stats(deps.sessions.count());
  });

  app.get('/api/openapi.json', async () => ({
    openapi: '3.0.0',
    info: { title: 'Virtual Hostess API', version: '0.9.0' },
    servers: [{ url: '/' }],
    components: {
      schemas: {
        Source: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            snippet: { type: 'string' },
            score: { type: 'number' },
            sourcePath: { type: 'string' },
            zone: { type: 'string', nullable: true },
            zoneTitle: { type: 'string', nullable: true },
            vectorScore: { type: 'number', nullable: true },
            keywordScore: { type: 'number', nullable: true },
          },
          required: ['title', 'snippet', 'score', 'sourcePath'],
        },
        ChatRequest: {
          type: 'object',
          required: ['message'],
          properties: {
            message: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX_CHARS },
            sessionId: { type: 'string', maxLength: 64 },
          },
        },
        ChatResponse: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
            sources: { type: 'array', items: { $ref: '#/components/schemas/Source' } },
            mode: { type: 'string', enum: ['rag', 'llm_only'] },
            provider: { type: 'string' },
            retrieval: { type: 'string', enum: ['hybrid', 'keyword'] },
            noHit: { type: 'boolean', description: '相关性闸门未通过（知识库未覆盖）' },
            sessionId: { type: 'string', nullable: true },
            latencyMs: { type: 'number' },
            cached: { type: 'boolean' },
          },
          required: ['answer', 'sources', 'mode', 'provider', 'retrieval', 'noHit'],
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
            requestId: { type: 'string', nullable: true },
          },
          required: ['error', 'message'],
        },
      },
      securitySchemes: {
        adminToken: { type: 'http', scheme: 'bearer' },
      },
    },
    paths: {
      '/api/health': {
        get: {
          summary: '运行状态',
          responses: { '200': { description: '健康信息（含检索模式、阈值、CORS 白名单）' } },
        },
      },
      '/api/chat': {
        post: {
          summary: '问答（非流式）',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } } },
          },
          responses: {
            '200': {
              description: '回答',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatResponse' } } },
            },
            '400': {
              description: '入参非法',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
            },
            '429': { description: '超出限流 CHAT_RATE_PER_MIN' },
          },
        },
      },
      '/api/chat/stream': {
        post: {
          summary: '问答（SSE：meta → delta* → done）',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatRequest' } } },
          },
          responses: { '200': { description: 'text/event-stream' } },
        },
      },
      '/api/suggestions': {
        get: {
          summary: '推荐问题',
          parameters: [
            { name: 'zone', in: 'query', schema: { type: 'string' }, description: 'zoneId 或 mediaId' },
          ],
          responses: { '200': { description: '推荐问法列表' } },
        },
      },
      '/api/zones': { get: { summary: '展区分区与媒体映射', responses: { '200': { description: 'zones' } } } },
      '/api/knowledge/list': {
        get: { summary: '知识文件清单', responses: { '200': { description: 'docs + retrieval stats' } } },
      },
      '/api/knowledge/reload': {
        post: {
          summary: '重载知识并重建向量索引',
          security: [{ adminToken: [] }],
          responses: { '200': { description: 'reload 结果' }, '401': { description: 'unauthorized' } },
        },
      },
      '/api/admin/feedback-stats': {
        get: {
          summary: '反馈统计（?format=csv 导出）',
          security: [{ adminToken: [] }],
          parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'] } }],
          responses: { '200': { description: '统计或 CSV' }, '401': { description: 'unauthorized' } },
        },
      },
      '/api/sessions/{sessionId}': {
        get: { summary: '查看会话', responses: { '200': { description: 'messages' }, '404': { description: '无会话' } } },
        delete: { summary: '重置会话', responses: { '200': { description: 'ok' } } },
      },
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
      const parsed = parseChatInput(req.body);
      if (!parsed.ok) {
        return reply
          .code(400)
          .send(errorPayload('validation_error', validationMessage(parsed.reason), rid));
      }
      const { message, sessionId } = parsed.value;
      const started = Date.now();

      const replyHeaders = {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // 反代（nginx/Caddy）不得缓冲流式响应
        'x-accel-buffering': 'no',
        'x-request-id': rid,
        ...corsHeadersFor(req.headers.origin, deps.corsOrigins),
      };
      reply.raw.writeHead(200, replyHeaders);

      let closed = false;
      // 注意：req.raw 的 'close' 在请求体读完时就会触发，不能用来判断客户端断开；
      // 只有在响应尚未写完（writableEnded=false）时才说明连接真的断了。
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) closed = true;
      });
      const send = (event: string, data: unknown) => {
        if (closed) return;
        reply.raw.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
      };
      // 心跳注释：模型思考期长时，避免中间设备把连接判为僵死
      const heartbeat = setInterval(() => {
        if (!closed) reply.raw.write(': ping\n\n');
      }, 15_000);

      try {
        for await (const ev of streamChat(deps, { message, sessionId, started })) {
          if (closed) break;
          if (ev.type === 'meta') {
            send('meta', {
              mode: ev.mode,
              sources: ev.sources,
              provider: ev.provider,
              noHit: ev.noHit,
              retrieval: ev.retrieval,
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
              noHit: ev.noHit,
              retrieval: ev.retrieval,
              cached: ev.cached,
            });
          }
        }
      } catch (err) {
        req.log.error({ requestId: rid, err }, 'sse chat failed');
        send('error', errorPayload('internal_error', '服务内部错误', rid));
      } finally {
        clearInterval(heartbeat);
        if (!reply.raw.writableEnded) reply.raw.end();
      }
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

    const parsed = parseChatInput(req.body);
    if (!parsed.ok) {
      return reply
        .code(400)
        .send(errorPayload('validation_error', validationMessage(parsed.reason), rid));
    }
    const { message, sessionId } = parsed.value;
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
