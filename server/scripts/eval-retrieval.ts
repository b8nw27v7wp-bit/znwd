/**
 * Hybrid 检索评测：node_modules tsx 执行
 * 用法：npm run eval:retrieval -w server
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnowledge } from '../src/knowledge/loader.ts';
import { VectorStore } from '../src/knowledge/vectorStore.ts';
import { HybridRetriever, resolveThresholds } from '../src/knowledge/hybridRetriever.ts';
import { createEmbeddingProvider } from '../src/embedding/index.ts';
import { rewriteForRetrieval } from '../src/rag/rewrite.ts';
import { loadDotEnv } from '../src/config/dotenv.ts';

interface EvalCase {
  id: string;
  question: string;
  zone?: string | null;
  sourcePathIncludes?: string | null;
  /** 追问用例：上一轮问题，用于验证多轮指代改写 */
  context?: string;
  note?: string;
}

function hitMatches(c: EvalCase, h: { zone?: string; sourcePath: string } | undefined): boolean {
  if (!h) return false;
  if (c.zone && h.zone === c.zone) return true;
  if (c.sourcePathIncludes && h.sourcePath.includes(c.sourcePathIncludes)) return true;
  return false;
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(here, '..');
  const repoRoot = path.resolve(serverRoot, '..');
  const casesPath = path.join(serverRoot, 'eval', 'retrieval-cases.json');
  const raw = JSON.parse(await readFile(casesPath, 'utf8')) as { cases: EvalCase[] };
  const cases = raw.cases ?? [];
  if (cases.length === 0) throw new Error('no eval cases');

  // .env 由共享实现加载（此前这里内联了第三份重复逻辑）
  await loadDotEnv();

  const knowledgeDir = path.resolve(repoRoot, process.env.KNOWLEDGE_DIR || './knowledge');
  const indexDir = path.resolve(
    process.env.INDEX_DIR
      ? path.resolve(repoRoot, process.env.INDEX_DIR)
      : path.join(serverRoot, 'indexes'),
  );
  const embedder = createEmbeddingProvider(process.env);
  const vectorStore = new VectorStore(embedder, path.join(indexDir, `vectors.${embedder.name}.json`));
  const retriever = new HybridRetriever(vectorStore, resolveThresholds());
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
    const match = (h: { zone?: string; sourcePath: string } | undefined) => hitMatches(c, h);
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

  // —— 多轮指代改写：同一批追问用例下「不改写 vs 改写」命中对比 ——
  const followUps = (raw.followUps ?? []).filter((c) => c.context);
  let fuRawTop1 = 0;
  let fuRawTop3 = 0;
  let fuRwTop1 = 0;
  let fuRwTop3 = 0;
  let fuRewritten = 0;
  const fuRows: Array<{
    id: string;
    context: string;
    question: string;
    rewritten: boolean;
    reason: string;
    rawTop1: string | null;
    rwTop1: string | null;
    rawHit1: boolean;
    rwHit1: boolean;
    rwHit3: boolean;
  }> = [];

  for (const c of followUps) {
    const rawHits = await retriever.retrieve(c.question, 4);
    const history = [
      { role: 'user' as const, content: c.context as string },
      { role: 'assistant' as const, content: '' },
    ];
    const rw = rewriteForRetrieval(retriever, c.question, history);
    const rwHits = (await retriever.retrieveWithDiagnostics(rw.query, { topK: 4 })).hits;
    const rawHit1 = hitMatches(c, rawHits[0]);
    const rawHit3 = rawHits.slice(0, 3).some((h) => hitMatches(c, h));
    const rwHit1 = hitMatches(c, rwHits[0]);
    const rwHit3 = rwHits.slice(0, 3).some((h) => hitMatches(c, h));
    if (rawHit1) fuRawTop1++;
    if (rawHit3) fuRawTop3++;
    if (rwHit1) fuRwTop1++;
    if (rwHit3) fuRwTop3++;
    if (rw.rewritten) fuRewritten++;
    fuRows.push({
      id: c.id,
      context: c.context as string,
      question: c.question,
      rewritten: rw.rewritten,
      reason: rw.reason,
      rawTop1: rawHits[0]?.title ?? null,
      rwTop1: rwHits[0]?.title ?? null,
      rawHit1,
      rwHit1,
      rwHit3,
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
    /** 追问（多轮指代）用例：不改写 vs 改写的命中对比 */
    followUpCases: followUps.length,
    followUpRawTop1Rate: followUps.length ? Number((fuRawTop1 / followUps.length).toFixed(4)) : 0,
    followUpRawTop3Rate: followUps.length ? Number((fuRawTop3 / followUps.length).toFixed(4)) : 0,
    followUpRewrittenTop1Rate: followUps.length ? Number((fuRwTop1 / followUps.length).toFixed(4)) : 0,
    followUpRewrittenTop3Rate: followUps.length ? Number((fuRwTop3 / followUps.length).toFixed(4)) : 0,
    followUpRewriteTriggered: fuRewritten,
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
  if (fuRows.length) {
    console.log('\n— 追问（多轮指代）—');
    for (const r of fuRows) {
      console.log(
        r.rwHit1 ? 'H1' : r.rwHit3 ? 'H3' : 'MISS',
        r.rewritten ? `RW:${r.reason}` : '       ',
        r.id,
        `[上文] ${r.context}`,
        `[追问] ${r.question}`,
        '→',
        r.rwTop1 ?? '-',
        r.rawHit1 === r.rwHit1 ? '' : `(不改写时: ${r.rawTop1 ?? '无命中'})`,
      );
    }
  }

  const outDir = path.join(repoRoot, 'docs', 'eval');
  if (process.argv.includes('--no-write')) {
    console.log('(--no-write：不写 baseline/report，仅打印)');
    return;
  }
  await mkdir(outDir, { recursive: true });
  const stamp = summary.at.replace(/[:.]/g, '-');
  const reportPath = path.join(outDir, `retrieval-${stamp}.json`);
  await writeFile(
    reportPath,
    JSON.stringify({ summary, rows, followUps: fuRows }, null, 2),
    'utf8',
  );
  // also write/update baseline pointer
  const baselinePath = path.join(outDir, 'baseline.json');
  await writeFile(baselinePath, JSON.stringify({ summary, rows, followUps: fuRows }, null, 2), 'utf8');
  console.log('wrote', reportPath);
  console.log('wrote', baselinePath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
