import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createChatModel } from './llm/index.js';
import { createEmbeddingProvider } from './embedding/index.js';
import { loadKnowledge } from './knowledge/loader.js';
import { VectorStore } from './knowledge/vectorStore.js';
import { HybridRetriever } from './knowledge/hybridRetriever.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerKnowledgeRoutes } from './routes/knowledge.js';
import { SessionStore } from './session/store.js';
import { Analytics } from './analytics/stats.js';
import { RateLimiter } from './http/rateLimit.js';

async function loadDotEnv(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(here, '../.env');
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // .env 可选
  }
}

async function main() {
  await loadDotEnv();

  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '0.0.0.0';
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/ → server/；dist/ → server/
  const serverRoot = path.resolve(here, '..');
  const repoRoot = path.resolve(serverRoot, '..');
  const knowledgeDir = path.resolve(repoRoot, process.env.KNOWLEDGE_DIR || './knowledge');
  const chatPerMin = Number(process.env.CHAT_RATE_PER_MIN || 30);
  const indexDir = path.resolve(
    process.env.INDEX_DIR ? path.resolve(repoRoot, process.env.INDEX_DIR) : path.join(serverRoot, 'indexes'),
  );

  const embedder = createEmbeddingProvider(process.env);
  const vectorStore = new VectorStore(
    embedder,
    path.join(indexDir, `vectors.${embedder.name}.json`),
  );
  const retriever = new HybridRetriever(vectorStore);

  const initial = await loadKnowledge(knowledgeDir);
  await retriever.replace(initial);

  const model = createChatModel(process.env);
  const sessions = new SessionStore();
  const analytics = new Analytics();
  const chatLimiter = new RateLimiter(chatPerMin, 60_000);

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.get('/api/health', async () => ({
    ok: true,
    knowledgeChunks: retriever.list().length,
    llmProvider: model.name,
    embedding: vectorStore.stats().provider,
    retrieval: retriever.stats(),
    knowledgeDir,
    activeSessions: sessions.count(),
    uptimeSec: Math.floor(process.uptime()),
  }));

  registerKnowledgeRoutes(app, { retriever, knowledgeDir });
  registerChatRoutes(app, {
    retriever,
    model,
    sessions,
    analytics,
    chatLimiter,
    knowledgeDir,
  });

  await app.listen({ port, host });
  app.log.info(
    `server :${port} knowledge=${knowledgeDir} embed=${embedder.name} rate=${chatPerMin}/min`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
