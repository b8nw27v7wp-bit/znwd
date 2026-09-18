import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface KnowledgeChunk {
  id: string;
  title: string;
  sourcePath: string;
  text: string;
  zone: string;
  zoneTitle: string;
  tags: string[];
}

const TEXT_EXT = new Set(['.md', '.txt', '.markdown']);

export interface ZonesMeta {
  zones: Array<{
    id: string;
    dir: string;
    title: string;
    aliases?: string[];
    suggestions?: string[];
  }>;
  media?: Array<{ mediaId: string; title: string; zoneId: string }>;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) {
    return { meta: {}, body: raw };
  }
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: raw };
  const head = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  const meta: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body };
}

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

  return chunks.flatMap((c) => {
    if (c.length <= maxChars * 1.5) return [c];
    const parts: string[] = [];
    for (let i = 0; i < c.length; i += maxChars) parts.push(c.slice(i, i + maxChars));
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
      if (entry.name === '_meta') continue;
      await walk(full, out);
    } else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

export async function loadZonesMeta(knowledgeDir: string): Promise<ZonesMeta> {
  const p = path.join(path.resolve(knowledgeDir), '_meta', 'zones.json');
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw) as ZonesMeta;
  } catch {
    return { zones: [] };
  }
}

function zoneForPath(relPath: string, zones: ZonesMeta['zones']) {
  const top = relPath.split(/[\\/]/)[0] || '';
  const hit = zones.find((z) => z.dir === top || relPath.startsWith(z.dir + '/') || z.dir === relPath.split(/[\\/]/)[0]);
  return hit || { id: 'default', title: '未分组', aliases: [] as string[] };
}

export async function loadKnowledge(knowledgeDir: string): Promise<KnowledgeChunk[]> {
  const root = path.resolve(knowledgeDir);
  const meta = await loadZonesMeta(root);
  const files = await walk(root);
  const chunks: KnowledgeChunk[] = [];

  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8');
    const { meta: fm, body } = parseFrontmatter(raw);
    const rel = path.relative(root, file);
    const zoneHit = zoneForPath(rel, meta.zones);

    const title =
      fm.title ||
      body
        .split('\n')
        .find((line) => line.startsWith('# '))
        ?.replace(/^#\s+/, '')
        .trim() ||
      path.basename(file, path.extname(file));

    const zone = fm.zone || zoneHit.id;
    const zoneTitle = fm.zoneTitle || zoneHit.title || '未分组';
    const tags = (fm.tags || (zoneHit.aliases || []).join(','))
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const parts = chunkText(body);
    parts.forEach((text, i) => {
      chunks.push({
        id: `${rel}#${i}`,
        title,
        sourcePath: rel,
        text,
        zone,
        zoneTitle,
        tags,
      });
    });
  }

  return chunks;
}
