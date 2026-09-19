/**
 * 资料入库：把 PDF / Word / txt 转成 knowledge/ 下的 Markdown（供 RAG 检索）。
 *
 * 用法（在仓库根）：
 *   npm run ingest -w server -- --src ./inbox --zone pv-clean [--force] [--dry-run]
 *
 * 依赖（本机已具备，缺失会给出明确提示而不是静默失败）：
 *   - PDF：`pdftotext`（xpdf/poppler，命令行）
 *   - DOCX：python + python-docx
 *   - txt/md：直接读
 *
 * 注意：
 *   - 输出必须是 .md/.txt（loader 只吃这两种），因此这里统一转成 Markdown；
 *   - 已存在的目标文件默认不覆盖，需显式 --force；
 *   - 入库后必须 `POST /api/knowledge/reload`，并重跑 calibrate + eval:retrieval。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadZonesMeta } from '../src/knowledge/loader.ts';

const execFileAsync = promisify(execFile);

const SUPPORTED = new Set(['.pdf', '.docx', '.doc', '.txt', '.md', '.markdown']);

export interface IngestOptions {
  srcDir: string;
  knowledgeDir: string;
  zone: string;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function slugify(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').trim();
  const cleaned = base
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return cleaned.slice(0, 60) || 'doc';
}

/** 文本规范化：去页眉页脚样噪声、合并 PDF 的逐行断行、保留段落与标题 */
export function normalizeExtracted(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u000c/g, '\n') // 分页符
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''));

  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    // 纯页码行 / 纯分隔线丢掉
    if (/^[-—–\s]*\d{1,4}[-—–\s]*$/.test(t)) continue;
    if (/^[-=_*·\s]{4,}$/.test(t)) continue;
    kept.push(t);
  }

  // 段落重组：空行分段；非空行连续时并入同一段（PDF 每行都会断行）
  const blocks: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) blocks.push(buf.join(''));
    buf = [];
  };
  for (const line of kept) {
    if (!line) {
      flush();
      continue;
    }
    // 已是标题 / 表格行 / 列表项：原样保留，不再套 ##
    const alreadyMarked = /^(#{1,6}\s|\||[-*+]\s|\d+[.、)]\s)/.test(line);
    const isHeading =
      !alreadyMarked && !line.includes('|') && line.length <= 24 && !/[。！？；：,，.！?]$/.test(line);
    if (isHeading) {
      flush();
      blocks.push(`## ${line}`);
      continue;
    }
    if (alreadyMarked) {
      flush();
      const last = blocks[blocks.length - 1];
      // 连续表格行要贴在一起，否则 markdown 表格会散架
      if (line.startsWith('|') && last && last.startsWith('|')) {
        blocks[blocks.length - 1] = `${last}\n${line}`;
      } else {
        blocks.push(line);
      }
      continue;
    }
    // 拉丁文断行需要补空格，中文断行直接接上
    const prev = buf[buf.length - 1];
    if (prev && /[A-Za-z0-9,;:).!?]$/.test(prev) && /^[A-Za-z0-9(]/.test(line)) {
      buf[buf.length - 1] = `${prev} ${line}`;
    } else {
      buf.push(line);
    }
  }
  flush();

  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function hasCommand(cmd: string, args: string[] = ['-v']): Promise<boolean> {
  try {
    await execFileAsync(cmd, args, { timeout: 10_000 });
    return true;
  } catch (err) {
    // 命令存在但以非零码退出（xpdf 的 -v 就返回 99）→ 视为存在；ENOENT 才是真的缺失
    const code = (err as { code?: string | number }).code;
    return code !== 'ENOENT';
  }
}

/** PDF：优先 pdftotext（保留版面），无文字层时明确报错而不是产出空文件 */
export async function convertPdf(file: string): Promise<string> {
  if (!(await hasCommand('pdftotext', ['-v']))) {
    throw new Error('缺少 pdftotext（poppler/xpdf）。安装后再跑，或先把 PDF 另存为文本。');
  }
  const { stdout } = await execFileAsync('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  const text = normalizeExtracted(stdout);
  if (text.replace(/\s/g, '').length < 20) {
    throw new Error(
      '该 PDF 没有可提取的文字层（可能是扫描件/图片版）。需要 OCR：先转图片再用 vision 或 marker-pdf 识别。',
    );
  }
  return text;
}

/** DOCX：用 python-docx 取段落与表格（比 OCR 准，保留结构） */
const DOCX_PY = `
import sys, json
from docx import Document
doc = Document(sys.argv[1])
out = []
for p in doc.paragraphs:
    t = (p.text or '').strip()
    if not t:
        continue
    style = (p.style.name or '').lower()
    if style.startswith('heading') or style.startswith('标题'):
        level = ''.join(ch for ch in style if ch.isdigit()) or '2'
        out.append('#' * min(int(level) + 1, 6) + ' ' + t)
    elif style.startswith('list') or style.startswith('列表'):
        out.append('- ' + t)
    else:
        out.append(t)
for i, table in enumerate(doc.tables):
    out.append('')
    out.append('### 表格 %d' % (i + 1))
    for r, row in enumerate(table.rows):
        cells = [ (c.text or '').replace('|', '/').replace('\\n', ' ').strip() for c in row.cells ]
        out.append('| ' + ' | '.join(cells) + ' |')
        if r == 0:
            out.append('|' + ' --- |' * len(cells))
print('\\n'.join(out))
`;

export async function convertDocx(file: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('python', ['-c', DOCX_PY, file], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    const text = normalizeExtracted(stdout);
    if (text.replace(/\s/g, '').length < 5) throw new Error('DOCX 解析结果为空');
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/python-docx|No module named/i.test(msg)) {
      throw new Error('缺少 python-docx：pip install python-docx 后再跑（或另存为 txt）。');
    }
    throw new Error(`DOCX 转换失败：${msg.slice(0, 300)}`);
  }
}

async function listSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error(`源目录不存在：${dir}`);
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listSources(full)));
    } else if (SUPPORTED.has(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out.sort();
}

export async function ingestOne(file: string, opts: IngestOptions): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  let body: string;
  if (ext === '.pdf') body = await convertPdf(file);
  else if (ext === '.docx') body = await convertDocx(file);
  else if (ext === '.doc') throw new Error('旧版 .doc 请先另存为 .docx 或 .txt（本机无 libreoffice）');
  else body = normalizeExtracted(await fs.readFile(file, 'utf8'));

  const meta = await loadZonesMeta(opts.knowledgeDir);
  const zone = meta.zones.find((z) => z.id === opts.zone || z.dir === opts.zone);
  if (!zone) {
    throw new Error(
      `未知展区：${opts.zone}。可选：${meta.zones.map((z) => z.id).join(', ')}（或先用 _meta/zones.json 新增展区）`,
    );
  }
  const targetDir = path.join(path.resolve(opts.knowledgeDir), zone.dir);
  const target = path.join(targetDir, `${slugify(path.basename(file))}.md`);

  const head = [
    '---',
    `title: ${slugify(path.basename(file))}`,
    `zone: ${zone.id}`,
    `tags: ${zone.id},ingest`,
    `source: ${path.basename(file)}`,
    `ingestedAt: ${new Date().toISOString().slice(0, 10)}`,
    '---',
    '',
  ].join('\n');
  const content = head + body + '\n';

  if (opts.dryRun) return `[dry-run] ${path.relative(process.cwd(), target)} (${content.length} 字符)`;
  await fs.mkdir(targetDir, { recursive: true });
  let exists = true;
  try {
    await fs.access(target);
  } catch {
    exists = false;
  }
  if (exists && !opts.force) {
    throw new Error(`目标已存在（加 --force 覆盖）：${path.relative(process.cwd(), target)}`);
  }
  await fs.writeFile(target, content, 'utf8');
  return `${path.relative(process.cwd(), target)} (${content.length} 字符)`;
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const args = parseArgs(process.argv.slice(2));
  const srcDir = path.resolve(repoRoot, String(args.src ?? './inbox'));
  const knowledgeDir = path.resolve(repoRoot, String(args.knowledge ?? './knowledge'));
  const zone = typeof args.zone === 'string' ? args.zone : '';
  if (!zone) {
    console.error('用法：npm run ingest -w server -- --src <目录> --zone <展区id> [--force] [--dry-run]');
    process.exit(2);
  }
  const opts: IngestOptions = {
    srcDir,
    knowledgeDir,
    zone,
    force: args.force === true,
    dryRun: args['dry-run'] === true,
  };

  const files = await listSources(srcDir);
  if (files.length === 0) {
    console.log(`源目录没有可入库文件（支持 ${[...SUPPORTED].join(' / ')}）：${srcDir}`);
    return;
  }
  let ok = 0;
  const failed: string[] = [];
  for (const file of files) {
    try {
      const result = await ingestOne(file, opts);
      ok++;
      console.log('OK  ', path.basename(file), '→', result);
    } catch (err) {
      failed.push(`${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
      console.log('FAIL', path.basename(file), '→', err instanceof Error ? err.message : String(err));
    }
  }
  console.log(`\n完成：${ok}/${files.length} 入库${opts.dryRun ? '（dry-run，未写盘）' : ''}`);
  if (failed.length) console.log('失败：\n  ' + failed.join('\n  '));
  console.log('\n下一步：');
  console.log('  1) POST /api/knowledge/reload（或重启 server）');
  console.log('  2) npm run calibrate -w server   # 阈值要按新知识重标');
  console.log('  3) npm run eval:retrieval        # top1/top3 不退化、gateBlockedCount=0');
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}



