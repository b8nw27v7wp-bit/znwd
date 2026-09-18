import type { KnowledgeChunk } from '../knowledge/loader.js';

function pickLines(text: string, max = 3): string[] {
  return text
    .split(/\n+/)
    .map((l) => l.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l.length >= 8 && !l.startsWith('|') && !l.startsWith('---'))
    .slice(0, max);
}

/** 从 system 上下文里抽「【片段 i|title|zone|path】 body */
function extractChunks(context: string): Array<{ title: string; body: string }> {
  const re = /【片段\s*\d+｜([^｜]+)｜([^｜]*)｜([^】]*)】\n([\s\S]*?)(?=\n\n【片段|\n*$)/g;
  const out: Array<{ title: string; body: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(context)) !== null) {
    out.push({ title: m[1].trim(), body: m[4].trim() });
  }
  return out;
}

export interface GroundedAnswerInput {
  question: string;
  context: string;
  historyTurns: number;
}

/**
 * 离线演示模型：尽量从检索片段抽取要点，减少空话。
 * 接入 openai_compat 后由真实模型覆盖。
 */
export function buildGroundedAnswer(input: GroundedAnswerInput): string {
  const chunks = extractChunks(input.context);
  const noHit = input.context.includes('（无命中片段）');
  const multi = input.historyTurns > 0 ? `\n（已结合前序 ${input.historyTurns} 轮对话）` : '';

  if (noHit || chunks.length === 0) {
    return [
      `关于「${input.question}」：`,
      `当前知识库未检索到直接相关内容。`,
      `可查看对应展区说明，或询问现场讲解员/业务同事。${multi}`,
      `（Mock 演示回复 · 未绑定知识片段）`,
    ].join('\n');
  }

  const lines: string[] = [`关于「${input.question}」，根据展厅资料：`];
  const shown = chunks.slice(0, 3);
  shown.forEach((c, i) => {
    const bullets = pickLines(c.body, 3);
    if (bullets.length) {
      lines.push(`\n${i + 1}. 【${c.title}】`);
      for (const b of bullets) lines.push(`   · ${b}`);
    } else {
      lines.push(`\n${i + 1}. 【${c.title}】${c.body.slice(0, 80)}`);
    }
  });
  lines.push(`\n如需完整参数或方案对接，请联系现场讲解或业务同事。${multi}`);
  lines.push(`（Mock 演示回复 · 基于检索片段整理）`);
  return lines.join('\n');
}

export function relatedFromChunks(chunks: KnowledgeChunk[], usedPaths: Set<string>): string[] {
  return chunks.filter((c) => !usedPaths.has(c.sourcePath)).slice(0, 3).map((c) => c.title);
}
