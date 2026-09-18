import type { FastifyInstance } from 'fastify';
import { answerQuestion } from '../rag/pipeline.js';
import type { ChatModel } from '../llm/types.js';
import type { Retriever } from '../knowledge/retriever.js';
import type { SessionStore } from '../session/store.js';
import { SUGGESTIONS } from '../knowledge/suggestions.js';

export function registerChatRoutes(
  app: FastifyInstance,
  deps: { retriever: Retriever; model: ChatModel; sessions: SessionStore },
): void {
  app.get('/api/suggestions', async () => ({ items: [...SUGGESTIONS] }));

  app.post<{ Body: { message?: string; sessionId?: string } }>('/api/chat', async (req, reply) => {
    const message = (req.body?.message ?? '').trim().slice(0, 2000);
    if (!message) {
      return reply.code(400).send({ error: 'message is required' });
    }
    const sessionId =
      typeof req.body.sessionId === 'string' && req.body.sessionId.trim()
        ? req.body.sessionId.trim().slice(0, 64)
        : undefined;

    try {
      const history = deps.sessions.history(sessionId);
      const result = await answerQuestion(deps.retriever, deps.model, message, { history });
      deps.sessions.append(sessionId, message, result.answer);
      return {
        answer: result.answer,
        sources: result.sources,
        mode: result.mode,
        provider: result.provider,
        sessionId: sessionId ?? null,
      };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'chat failed' });
    }
  });
}
