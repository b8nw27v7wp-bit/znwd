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
import { LruCache, JsonlStore, type CachedAnswer } from './http/cache.js';
import { adminTokenRequired, errorPayload } from './http/errors.js';

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
    // optional
  }
}

async function main() {
  await loadDotEnv();

  const port = Number(process.env.PORT || 8787);
  // Phase A S1: 默认仅本机监听；跨机访问请显式配置 HOST 或经反代暴露
  const host = process.env.HOST || '127.0.0.1';
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(here, '..');
  const repoRoot = path.resolve(serverRoot, '..');
  const knowledgeDir = path.resolve(repoRoot, process.env.KNOWLEDGE_DIR || './knowledge');
  const chatPerMin = Number(process.env.CHAT_RATE_PER_MIN || 30);
  const indexDir = path.resolve(
    process.env.INDEX_DIR
      ? path.resolve(repoRoot, process.env.INDEX_DIR)
      : path.join(serverRoot, 'indexes'),
  );
  const dataDir = path.resolve(
    process.env.DATA_DIR ? path.resolve(repoRoot, process.env.DATA_DIR) : path.join(serverRoot, 'data'),
  );
  const adminToken = process.env.ADMIN_TOKEN || undefined;
  const requireAdmin = adminTokenRequired(process.env);
  const cacheSize = Number(process.env.ANSWER_CACHE_SIZE || 200);
  const watchKnowledge = (process.env.KNOWLEDGE_WATCH || 'false').toLowerCase() === 'true';
  const logMaxBytes = Number(process.env.LOG_MAX_BYTES || 5_000_000);
  const logMessageMode =
    (process.env.LOG_MESSAGE_MODE || 'hash').toLowerCase() === 'preview' ? 'preview' : 'hash';

  if (requireAdmin && !adminToken) {
    console.error(
      '[security] ADMIN_TOKEN is required in this environment (NODE_ENV/REQUIRE_ADMIN_TOKEN) but not set; /api/stats and /api/knowledge/reload will return 401',
    );
  } else if (!requireAdmin && !adminToken) {
    console.warn(
      '[security] ADMIN_TOKEN unset — admin routes open (dev only). Set ADMIN_TOKEN and NODE_ENV=production before deployment.',
    );
  }

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
  const answerCache = new LruCache<CachedAnswer>(cacheSize);
  const logStore = new JsonlStore(dataDir, 'events', {
    maxBytes: logMaxBytes,
    messageMode: logMessageMode,
  });

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.setErrorHandler((err: unknown, req, reply) => {
    const rid = String(req.id ?? '');
    req.log.error({ requestId: rid, err }, 'unhandled route error');
    const e = err as { statusCode?: number; code?: string; message?: string };
    const status = typeof e?.statusCode === 'number' && e.statusCode >= 400 ? e.statusCode : 500;
    if (status < 500) {
      const code = e?.code === 'FST_ERR_VALIDATION' ? 'validation_error' : 'request_error';
      return reply.code(status).send(errorPayload(code, '请求参数无效', rid));
    }
    return reply.code(500).send(errorPayload('internal_error', '服务内部错误', rid));
  });

  app.get('/api/health', async () => ({
    ok: true,
    knowledgeChunks: retriever.list().length,
    llmProvider: model.name,
    embedding: vectorStore.stats().provider,
    retrieval: retriever.stats(),
    knowledgeDir,
    activeSessions: sessions.count(),
    answerCacheSize: answerCache.size,
    dataDir,
    watchKnowledge,
    adminTokenRequired: requireAdmin,
    host,
    uptimeSec: Math.floor(process.uptime()),
  }));

  registerKnowledgeRoutes(app, {
    retriever,
    knowledgeDir,
    adminToken,
    adminTokenRequired: requireAdmin,
    onReloaded: () => answerCache.clear(),
  });
  registerChatRoutes(app, {
    retriever,
    model,
    sessions,
    analytics,
    chatLimiter,
    knowledgeDir,
    adminToken,
    adminTokenRequired: requireAdmin,
    answerCache,
    logStore,
  });

  if (watchKnowledge) {
    const { watch } = await import('node:fs');
    let timer: NodeJS.Timeout | null = null;
    const reload = async () => {
      try {
        const chunks = await loadKnowledge(knowledgeDir);
        await retriever.replace(chunks);
        answerCache.clear();
        app.log.info(`knowledge watched reload: ${chunks.length} chunks`);
      } catch (e) {
        app.log.error(e);
      }
    };
    watch(knowledgeDir, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), 800);
    });
    app.log.info(`knowledge watch enabled: ${knowledgeDir}`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`received ${signal}, shutting down`);
    const timer = setTimeout(() => {
      app.log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, 8000);
    timer.unref?.();
    try {
      await app.close();
      await logStore.flush();
      app.log.info('shutdown complete');
      process.exit(0);
    } catch (e) {
      app.log.error(e);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port, host });
  app.log.info(
    `server :${port} host=${host} knowledge=${knowledgeDir} embed=${embedder.name} rate=${chatPerMin}/min data=${dataDir} adminRequired=${requireAdmin}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
