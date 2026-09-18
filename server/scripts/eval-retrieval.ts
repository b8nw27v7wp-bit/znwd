/**
 * Hybrid 检索评测：node_modules tsx 执行
 * 用法：npm run eval:retrieval -w server
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnowledge } from '../src/knowledge/loader.ts';
import { VectorStore } from '../src/knowledge/vectorStore.ts';
import { HybridRetriever } from '../src/knowledge/hybridRetriever.ts';
import { createEmbeddingProvider } from '../src/embedding/index.ts';

interface EvalCase {
  id: string;
  question: string;
  zone?: string | null;
  sourcePathIncludes?: string | null;
  note?: string;
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(here, '..');
  const repoRoot = path.resolve(serverRoot, '..');
  const casesPath = path.join(serverRoot, 'eval', 'retrieval-cases.json');
  const raw = JSON.parse(await readFile(casesPath, 'utf8')) as { cases: EvalCase[] };
  const cases = raw.cases ?? [];
  if (cases.length === 0) throw new Error('no eval cases');

  // load .env like server
  try {
    const envRaw = await readFile(path.join(serverRoot, '.env'), 'utf8');
    for (const line of envRaw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch {
    /* optional */
  }

  const knowledgeDir = path.resolve(repoRoot, process.env.KNOWLEDGE_DIR || './knowledge');
  const indexDir = path.resolve(
    process.env.INDEX_DIR
      ? path.resolve(repoRoot, process.env.INDEX_DIR)
      : path.join(serverRoot, 'indexes'),
  );
  const embedder = createEmbeddingProvider(process.env);
  const vectorStore = new VectorStore(embedder, path.join(indexDir, `vectors.${embedder.name}.json`));
  const retriever = new HybridRetriever(vectorStore);
  const chunks = await loadKnowledge(knowledgeDir);
  await retriever.replace(chunks);

  const scored = cases.filter((c) => c.zone || c.sourcePathIncludes);
  let top1 = 0;
  let top3 = 0;
  let gatedTop1 = 0;
  let gatedTop3 = 0;
  const gateBlocked: string[] = [];
  const rows: Array<{
    id: string;
    question: string;
    expectZone: string | null;
    top1: string | null;
    top1Path: string | null;
    hit1: boolean;
    hit3: boolean;
    gated: boolean;
    keywordBestScore: number;
  }> = [];

  for (const c of scored) {
    const hits = await retriever.retrieve(c.question, 4);
    const outcome = await retriever.retrieveWithDiagnostics(c.question, { topK: 4 });
    const top = hits.slice(0, 3);
    const match = (h: { zone?: string; sourcePath: string } | undefined) => {
      if (!h) return false;
      if (c.zone && h.zone === c.zone) return true;
      if (c.sourcePathIncludes && h.sourcePath.includes(c.sourcePathIncludes)) return true;
      return false;
    };
    const hit1 = match(hits[0]);
    const hit3 = top.some(match);
    if (hit1) top1++;
    if (hit3) top3++;
    // 闸门（生产路径）是否把这条例本该答的问题拦了 —— 误拦就是漏答
    const gTop = outcome.hits.slice(0, 3);
    const gHit1 = match(outcome.hits[0]);
    const gHit3 = gTop.some(match);
    if (gHit1) gatedTop1++;
    if (gHit3) gatedTop3++;
    if (outcome.hits.length === 0) gateBlocked.push(c.id);
    rows.push({
      id: c.id,
      question: c.question,
      expectZone: c.zone ?? null,
      top1: hits[0]?.title ?? null,
      top1Path: hits[0]?.sourcePath ?? null,
      hit1,
      hit3,
      gated: outcome.diagnostics.gated,
      keywordBestScore: outcome.diagnostics.keywordBestScore,
    });
  }

  const n = scored.length || 1;
  const summary = {
    at: new Date().toISOString(),
    embedProvider: embedder.name,
    semantic: embedder.semantic,
    llmProvider: process.env.LLM_PROVIDER || 'mock',
    knowledgeChunks: chunks.length,
    generation: retriever.generation(),
    cases: scored.length,
    openCases: cases.length - scored.length,
    top1Hit: top1,
    top3Hit: top3,
    top1Rate: Number((top1 / n).toFixed(4)),
    top3Rate: Number((top3 / n).toFixed(4)),
    /** 生产路径（含相关性闸门）指标；gateBlocked 是漏答（该答没答） */
    gatedTop1Rate: Number((gatedTop1 / n).toFixed(4)),
    gatedTop3Rate: Number((gatedTop3 / n).toFixed(4)),
    gateBlockedCount: gateBlocked.length,
    gateBlocked,
    minKeywordScore: retriever.stats().thresholds.minKeywordScore,
  };

  console.log(JSON.stringify(summary, null, 2));
  for (const r of rows) {
    console.log(
      (r.hit1 ? 'H1' : r.hit3 ? 'H3' : 'MISS'),
      r.gated ? 'GATED' : '     ',
      r.id,
      r.question,
      '→',
      r.top1 ?? '-',
      r.top1Path ?? '',
    );
  }

  const outDir = path.join(repoRoot, 'docs', 'eval');
  await mkdir(outDir, { recursive: true });
  const stamp = summary.at.replace(/[:.]/g, '-');
  const reportPath = path.join(outDir, `retrieval-${stamp}.json`);
  await writeFile(
    reportPath,
    JSON.stringify({ summary, rows }, null, 2),
    'utf8',
  );
  // also write/update baseline pointer
  const baselinePath = path.join(outDir, 'baseline.json');
  await writeFile(baselinePath, JSON.stringify({ summary, rows }, null, 2), 'utf8');
  console.log('wrote', reportPath);
  console.log('wrote', baselinePath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
