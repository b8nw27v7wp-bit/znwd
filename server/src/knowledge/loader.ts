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

/** 分块参数：长文档按标题分段、段落打包，超长段落滑窗切分并保留重叠 */
export const CHUNK_MAX_CHARS = 500;
export const CHUNK_OVERLAP_CHARS = 80;

function splitLong(text: string, maxChars: number, overlap: number): string[] {
  const parts: string[] = [];
  const step = Math.max(1, maxChars - overlap);
  for (let i = 0; i < text.length; i += step) {
    parts.push(text.slice(i, i + maxChars));
  }
  return parts;
}

function packParagraphs(paragraphs: string[], maxChars: number, overlap: number): string[] {
  const chunks: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if (!buf) {
      buf = p;
    } else if (buf.length + p.length + 2 <= maxChars) {
      buf = `${buf}\n\n${p}`;
    } else {
      chunks.push(buf);
      buf = p;
    }
    // 单段超长：先落盘已累积内容，再滑窗切分该段
    if (buf.length > maxChars * 1.5) {
      chunks.push(...splitLong(buf, maxChars, overlap));
      buf = '';
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/**
 * 标题感知分块：markdown 标题作为硬边界，块内保留标题上下文。
 * 此前实现只在段落累计超长时才切，且超长时按字符硬切无重叠，
 * 真实长文档（PDF/Word 转 md）会出现断句丢义。
 */
export function chunkText(text: string, maxChars = CHUNK_MAX_CHARS, overlap = CHUNK_OVERLAP_CHARS): string[] {
  const lines = text.split(/\r?\n/);
  const sections: Array<{ heading: string; paragraphs: string[] }> = [];
  let current: { heading: string; paragraphs: string[] } = { heading: '', paragraphs: [] };
  let buf: string[] = [];

  const flushParagraph = () => {
    const p = buf.join('\n').trim();
    if (p) current.paragraphs.push(p);
    buf = [];
  };

  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      flushParagraph();
      if (current.heading || current.paragraphs.length) sections.push(current);
      current = { heading: line.replace(/^#{1,6}\s+/, '').trim(), paragraphs: [] };
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    buf.push(line);
  }
  flushParagraph();
  if (current.heading || current.paragraphs.length) sections.push(current);

  const chunks: string[] = [];
  for (const section of sections) {
    const packed = packParagraphs(section.paragraphs, maxChars, overlap);
    packed.forEach((body, i) => {
      // 首块带上标题；后续块也带标题，避免脱离上下文后语义漂移
      const withHeading = section.heading
        ? i === 0
          ? `${section.heading}\n\n${body}`
          : `${section.heading}（续）\n\n${body}`
        : body;
      chunks.push(withHeading.trim());
    });
  }
  return chunks.filter(Boolean);
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
