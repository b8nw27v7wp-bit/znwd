/**
 * 打分参数调参：在评测用例 + 域外样本上网格搜索，用数据选参数而不是手调。
 *
 * 用法：npm run tune:scoring -w server
 * 输出每组的 top1 / top3 与闸门余量（在域最低分 - 域外最高分），按 top1 降序。
 * 改语料或改同义词表后重跑，把最优组合写回 retriever.ts 的 DEFAULT_SCORING。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnowledge } from '../src/knowledge/loader.ts';
import { Retriever } from '../src/knowledge/retriever.ts';
import { loadDotEnv } from '../src/config/dotenv.ts';

/** 与 calibrate 同一批域外样本：展厅里访客会问、但知识库不该硬答的问题 */
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

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '..');

await loadDotEnv();

const chunks = await loadKnowledge(path.join(repoRoot, 'knowledge'));
const raw = JSON.parse(
  await readFile(path.join(serverRoot, 'eval', 'retrieval-cases.json'), 'utf8'),
);
const scored = raw.cases.filter((c) => c.zone || c.sourcePathIncludes);

const hit = (c, h) => {
  if (!h) return false;
  if (c.zone && h.zone === c.zone) return true;
  if (c.sourcePathIncludes && h.sourcePath.includes(c.sourcePathIncludes)) return true;
  return false;
};

const combos = [];
for (const expansionWeight of [0.45, 0.7, 1.0]) {
  for (const maxTfBoost of [2.2, 5]) {
    for (const zoneBoost of [1.0, 1.5]) {
      for (const lengthB of [0, 0.3, 0.6]) {
        combos.push({ expansionWeight, maxTfBoost, zoneBoost, lengthB });
      }
    }
  }
}

const rows = [];
for (const combo of combos) {
  const r = new Retriever(combo);
  r.replace(chunks);
  let t1 = 0;
  let t3 = 0;
  const misses = [];
  for (const c of scored) {
    const hits = r.retrieve(c.question, 4);
    if (hit(c, hits[0])) t1++;
    else misses.push(c.id);
    if (hits.slice(0, 3).some((h) => hit(c, h))) t3++;
  }
  const inMin = Math.min(...scored.map((c) => r.retrieve(c.question, 4)[0]?.score ?? 0));
  const oodMax = Math.max(...OUT_OF_DOMAIN.map((q) => r.retrieve(q, 4)[0]?.score ?? 0));
  rows.push({
    ...combo,
    top1: t1 / scored.length,
    top3: t3 / scored.length,
    inMin,
    oodMax,
    gap: inMin - oodMax,
    misses,
  });
}

rows.sort((a, b) => b.top1 - a.top1 || b.top3 - a.top3 || b.gap - a.gap);
console.log(`chunks=${chunks.length} cases=${scored.length} 域外样本=${OUT_OF_DOMAIN.length}`);
console.log('expW  tfCap zoneB lenB | top1   top3   在域最低 域外最高 余量   失分');
for (const x of rows) {
  console.log(
    `${String(x.expansionWeight).padEnd(5)} ${String(x.maxTfBoost).padEnd(5)} ${String(x.zoneBoost).padEnd(5)} ${String(x.lengthB).padEnd(4)} | ` +
      `${x.top1.toFixed(4)} ${x.top3.toFixed(4)} ${x.inMin.toFixed(2).padStart(8)} ${x.oodMax.toFixed(2).padStart(8)} ` +
      `${x.gap.toFixed(2).padStart(6)}   ${x.misses.join(',') || '-'}`,
  );
}
