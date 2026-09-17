import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface KnowledgeChunk {
  id: string;
  title: string;
  sourcePath: string;
  text: string;
}

const TEXT_EXT = new Set(['.md', '.txt', '.markdown']);

function chunkText(text: string, maxChars = 500): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buf = '';

  for (const p of paragraphs) {
    if (!buf) {
      buf = p;
      continue;
    }
    if (buf.length + p.length + 2 <= maxChars) {
      buf = `${buf}\n\n${p}`;
    } else {
      chunks.push(buf);
      buf = p;
    }
  }
  if (buf) chunks.push(buf);

  // 超长段落再按句硬切
  return chunks.flatMap((c) => {
    if (c.length <= maxChars * 1.5) return [c];
    const parts: string[] = [];
    for (let i = 0; i < c.length; i += maxChars) {
      parts.push(c.slice(i, i + maxChars));
    }
    return parts;
  });
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

export async function loadKnowledge(knowledgeDir: string): Promise<KnowledgeChunk[]> {
  const root = path.resolve(knowledgeDir);
  const files = await walk(root);
  const chunks: KnowledgeChunk[] = [];

  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const title =
      raw
        .split('\n')
        .find((line) => line.startsWith('# '))
        ?.replace(/^#\s+/, '')
        .trim() || path.basename(file, path.extname(file));

    const parts = chunkText(raw);
    parts.forEach((text, i) => {
      chunks.push({
        id: `${path.basename(file)}#${i}`,
        title,
        sourcePath: path.relative(root, file),
        text,
      });
    });
  }

  return chunks;
}
