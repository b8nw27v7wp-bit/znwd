function pickLines(text: string, max = 3): string[] {
  return text
    .split(/\n+/)
    .map((l) =>
      l
        .replace(/^#+\s*/, '')
        .replace(/^\s*[-*+•]\s+/, '')
        .replace(/^\s*\d+[.、)]\s*/, '')
        .replace(/\*\*/g, '')
        .trim(),
    )
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
  const multi = input.historyTurns > 0 ? `\n（已结合前序 ${input.historyTurns} 轮对话）` : '';

  if (chunks.length === 0) {
    return [
      `关于「${input.question}」：展厅资料中没有这方面的内容。`,
      `可以换个问法，例如：`,
      `   · 光伏清洁无人机是做什么的？`,
      `   · 风场检测无人机怎么检测叶片？`,
      `   · 提供哪些培训与服务合作？`,
      `（Mock 演示回复 · 未命中知识片段）${multi}`,
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
