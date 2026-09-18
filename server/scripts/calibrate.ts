/**
 * 相关性阈值标定：同一批问题下「关键词路最佳分 / 向量路最佳余弦」分布。
 * 用途：知识库或同义词变更后，重新确认 MIN_RELEVANCE_SCORE 是否仍能区分
 *       在域问题与域外闲聊，避免闸门过松（乱答）或过紧（该答不答）。
 * 用法：npm run calibrate -w server
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnowledge } from '../src/knowledge/loader.ts';
import { Retriever } from '../src/knowledge/retriever.ts';
import { VectorStore } from '../src/knowledge/vectorStore.ts';
import { createEmbeddingProvider } from '../src/embedding/index.ts';

/** 域外样本：展厅里访客会问、但知识库不该硬答的问题 */
const OUT_OF_DOMAIN = [
  '今天上海天气怎么样？',
  '帮我写一首诗',
  '你是谁？',
  '午饭吃什么好',
  '股票行情怎么样',
  '帮我订一张去北京的机票',
  '讲个笑话',
  '你用的什么大模型',
  '会议室在哪里',
  '洗手间怎么走',
];

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(here, '..');
  const repoRoot = path.resolve(serverRoot, '..');

  const chunks = await loadKnowledge(path.join(repoRoot, 'knowledge'));
  const keyword = new Retriever();
  keyword.replace(chunks);

  const embedder = createEmbeddingProvider(process.env);
  const vectors = new VectorStore(embedder, path.join(serverRoot, 'indexes', `vectors.${embedder.name}.json`));
  if (!(await vectors.tryLoad(chunks))) await vectors.build(chunks);

  const caseFile = JSON.parse(
    await readFile(path.join(serverRoot, 'eval', 'retrieval-cases.json'), 'utf8'),
  ) as { cases: Array<{ id: string; question: string; zone?: string | null; sourcePathIncludes?: string | null }> };

  // 开放问（没有期望 zone/文件）不计入区间：这类问题本就该被闸门拦下
  const scored = caseFile.cases.filter((c) => c.zone || c.sourcePathIncludes);

  const measure = async (id: string, question: string) => {
    const kw = keyword.retrieve(question, 8);
    const vec = await vectors.search(question, 8);
    return {
      id,
      question,
      keywordBest: kw[0]?.score ?? 0,
      keywordTop: kw[0]?.title ?? '-',
      matchedTokens: kw[0]?.matchedTokens ?? 0,
      matched: (kw[0]?.matched ?? []).slice(0, 6).join('/'),
      vectorBest: vec[0]?.score ?? 0,
    };
  };

  const inDomain = (await Promise.all(scored.map((c) => measure(c.id, c.question)))).sort(
    (a, b) => a.keywordBest - b.keywordBest,
  );
  const ood = (await Promise.all(OUT_OF_DOMAIN.map((q, i) => measure(`ood-${i}`, q)))).sort(
    (a, b) => b.keywordBest - a.keywordBest,
  );

  console.log(`provider=${embedder.name} semantic=${embedder.semantic} chunks=${chunks.length}`);
  console.log('\n== 在域用例（关键词分升序，最弱 8 条）==');
  for (const r of inDomain.slice(0, 8)) {
    console.log(
      `  kw=${r.keywordBest.toFixed(3)} cov=${r.matchedTokens} cos=${r.vectorBest.toFixed(4)}  ${r.id}  ${r.question} → ${r.keywordTop}  [${r.matched}]`,
    );
  }
  console.log('\n== 域外问题（关键词分降序）==');
  for (const r of ood) {
    console.log(
      `  kw=${r.keywordBest.toFixed(3)} cov=${r.matchedTokens} cos=${r.vectorBest.toFixed(4)}  ${r.question} → ${r.keywordTop}  [${r.matched}]`,
    );
  }

  const minIn = inDomain[0]?.keywordBest ?? 0;
  const maxOod = ood[0]?.keywordBest ?? 0;
  const minCovIn = Math.min(...inDomain.map((r) => r.matchedTokens));
  const maxCovOod = Math.max(...ood.map((r) => r.matchedTokens));
  console.log(`\n关键词分：在域最低=${minIn.toFixed(3)}  域外最高=${maxOod.toFixed(3)}`);
  console.log(`命中词条数：在域最低=${minCovIn}  域外最高=${maxCovOod}`);
  if (minIn > maxOod) {
    const suggested = Number(((maxOod + minIn) / 2).toFixed(1));
    console.log(`区间可用：建议 MIN_RELEVANCE_SCORE=${suggested}（当前 ${process.env.MIN_RELEVANCE_SCORE ?? '默认 3.5'}）`);
  } else {
    console.log('警告：分数区间不成立（域外最高分不低于在域最低分）：需要补同义词或换语义向量模型');
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
