import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadKnowledge } from '../knowledge/loader.js';
import type { Retriever } from '../knowledge/retriever.js';

const TEXT_EXT = new Set(['.md', '.txt', '.markdown']);

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  deps: { retriever: Retriever; knowledgeDir: string },
): void {
  const { knowledgeDir, retriever } = deps;

  app.get('/api/knowledge/list', async () => {
    const root = path.resolve(knowledgeDir);
    const files = await walk(root);
    const docs: Array<{
      path: string;
      bytes: number;
      mtime: string;
      chunks: number;
      title: string;
    }> = [];

    for (const file of files) {
      const st = await fs.stat(file);
      const rel = path.relative(root, file);
      const related = retriever.list().filter((c) => c.sourcePath === rel);
      docs.push({
        path: rel,
        bytes: st.size,
        mtime: st.mtime.toISOString(),
        chunks: related.length,
        title: related[0]?.title ?? path.basename(file, path.extname(file)),
      });
    }

    docs.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
    return {
      knowledgeDir: root,
      fileCount: docs.length,
      chunkCount: retriever.list().length,
      docs,
    };
  });

  app.post('/api/knowledge/reload', async () => {
    const chunks = await loadKnowledge(knowledgeDir);
    retriever.replace(chunks);
    const byFile = new Map<string, number>();
    for (const c of chunks) {
      byFile.set(c.sourcePath, (byFile.get(c.sourcePath) || 0) + 1);
    }
    return {
      ok: true,
      knowledgeChunks: chunks.length,
      files: [...byFile.entries()].map(([sourcePath, chunkCount]) => ({
        sourcePath,
        chunks: chunkCount,
      })),
    };
  });
}
