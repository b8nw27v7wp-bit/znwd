import type { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'node:path';
import { loadKnowledge, loadZonesMeta } from '../knowledge/loader.js';
import type { HybridRetriever } from '../knowledge/hybridRetriever.js';
import { adminOk } from '../http/cache.js';

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  deps: {
    retriever: HybridRetriever;
    knowledgeDir: string;
    adminToken?: string;
    onReloaded?: () => void;
  },
): void {
  const { knowledgeDir, retriever, adminToken } = deps;

  app.get('/api/knowledge/list', async () => {
    const root = path.resolve(knowledgeDir);
    const chunks = retriever.list();
    const byFile = new Map<
      string,
      { title: string; zone: string; zoneTitle: string; chunks: number }
    >();
    for (const c of chunks) {
      const prev = byFile.get(c.sourcePath);
      if (prev) prev.chunks++;
      else
        byFile.set(c.sourcePath, {
          title: c.title,
          zone: c.zone,
          zoneTitle: c.zoneTitle,
          chunks: 1,
        });
    }
    const meta = await loadZonesMeta(knowledgeDir);
    return {
      knowledgeDir: root,
      fileCount: byFile.size,
      chunkCount: chunks.length,
      retrieval: retriever.stats(),
      zones: meta.zones,
      docs: [...byFile.entries()]
        .map(([sourcePath, v]) => ({ path: sourcePath, ...v }))
        .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN')),
    };
  });

  app.post('/api/knowledge/reload', async (req: FastifyRequest, reply) => {
    if (!adminOk(req.headers.authorization, adminToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const chunks = await loadKnowledge(knowledgeDir);
    await retriever.replace(chunks);
    deps.onReloaded?.();
    const byFile = new Map<string, number>();
    for (const c of chunks) byFile.set(c.sourcePath, (byFile.get(c.sourcePath) || 0) + 1);
    return {
      ok: true,
      knowledgeChunks: chunks.length,
      retrieval: retriever.stats(),
      files: [...byFile.entries()].map(([sourcePath, chunkCount]) => ({
        sourcePath,
        chunks: chunkCount,
      })),
    };
  });
}
