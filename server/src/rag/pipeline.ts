import type { ChatMessage, ChatModel } from '../llm/types.js';
import type { HybridHit, HybridRetriever } from '../knowledge/hybridRetriever.js';

export interface RagAnswer {
  answer: string;
  sources: Array<{
    title: string;
    snippet: string;
    score: number;
    sourcePath: string;
    zone?: string;
    zoneTitle?: string;
    vectorScore?: number;
    keywordScore?: number;
  }>;
  mode: 'rag' | 'llm_only';
  provider: string;
  retrieval: 'hybrid' | 'keyword';
}

const SYSTEM_BASE =
  '你是产品展厅的 AI 虚拟讲解员，主题为光伏清洁无人机与风场检测无人机。用简体中文、礼貌、简洁地回答产品、作业流程、服务合作与展厅参观相关问题。优先依据提供的企业知识；知识不足时明确说明并给出可操作建议。避免编造不确定的参数与承诺。';

export async function answerQuestion(
  retriever: HybridRetriever,
  model: ChatModel,
  message: string,
  options: { topK?: number; history?: ChatMessage[] } = {},
): Promise<RagAnswer> {
  const topK = options.topK ?? 4;
  const history = (options.history ?? []).slice(-12);
  const hits: HybridHit[] = await retriever.retrieve(message, topK);
  const messages: ChatMessage[] = [];

  if (hits.length > 0) {
    const contextBlock = hits
      .map(
        (h, i) =>
          `【片段 ${i + 1}｜${h.title}｜${h.zoneTitle || h.zone || ''}｜${h.sourcePath}】\n${h.text}`,
      )
      .join('\n\n');
    messages.push({
      role: 'system',
      content: `${SYSTEM_BASE}\n\n【企业知识】\n${contextBlock}`,
    });
  } else {
    messages.push({ role: 'system', content: `${SYSTEM_BASE}\n\n【企业知识】\n（无命中片段）` });
  }

  for (const turn of history) {
    if (turn.role === 'user' || turn.role === 'assistant') {
      messages.push({ role: turn.role, content: turn.content });
    }
  }
  messages.push({ role: 'user', content: message });

  const result = await model.complete({ messages });

  return {
    answer: result.content,
    sources: hits.map((h) => ({
      title: h.title,
      snippet: h.text.slice(0, 160),
      score: Number((h.score ?? 0).toFixed(4)),
      sourcePath: h.sourcePath,
      zone: h.zone,
      zoneTitle: h.zoneTitle,
      vectorScore: h.vectorScore,
      keywordScore: h.keywordScore,
    })),
    mode: hits.length > 0 ? 'rag' : 'llm_only',
    provider: result.provider,
    retrieval: 'hybrid',
  };
}
