import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createChatModel } from './llm/index.js';
import { loadKnowledge } from './knowledge/loader.js';
import { Retriever } from './knowledge/retriever.js';
import { registerChatRoutes } from './routes/chat.js';

// 轻量 .env 加载（无 dotenv 依赖）
async function loadDotEnv(): Promise<void> {
  const envPath = path.resolve(process.cwd(), '.env');
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
  // 默认相对仓库根：server/src 向上两级
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const knowledgeDir = path.resolve(repoRoot, process.env.KNOWLEDGE_DIR || './knowledge');

  const retriever = new Retriever();
  const initial = await loadKnowledge(knowledgeDir);
  retriever.replace(initial);

  const model = createChatModel(process.env);

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.get('/api/health', async () => ({
    ok: true,
    knowledgeChunks: retriever.list().length,
    llmProvider: model.name,
    knowledgeDir,
  }));

  app.post('/api/knowledge/reload', async () => {
    const chunks = await loadKnowledge(knowledgeDir);
    retriever.replace(chunks);
    return { ok: true, knowledgeChunks: chunks.length };
  });

  registerChatRoutes(app, { retriever, model });

  await app.listen({ port, host });
  app.log.info(`virtual-receptionist server on :${port}, knowledge=${knowledgeDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
