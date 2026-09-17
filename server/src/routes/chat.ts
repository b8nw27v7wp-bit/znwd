import type { FastifyInstance } from 'fastify';
import { answerQuestion } from '../rag/pipeline.js';
import type { ChatModel } from '../llm/types.js';
import type { Retriever } from '../knowledge/retriever.js';

export function registerChatRoutes(
  app: FastifyInstance,
  deps: { retriever: Retriever; model: ChatModel },
): void {
  app.post<{ Body: { message?: string; sessionId?: string } }>('/api/chat', async (req, reply) => {
    const message = (req.body?.message ?? '').trim().slice(0, 2000);
    if (!message) {
      return reply.code(400).send({ error: 'message is required' });
    }

    try {
      const result = await answerQuestion(deps.retriever, deps.model, message);
      return {
        answer: result.answer,
        sources: result.sources,
        mode: result.mode,
        provider: result.provider,
        sessionId: req.body.sessionId ?? null,
      };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'chat failed' });
    }
  });
}
