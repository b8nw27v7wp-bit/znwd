import type { ChatMessage, ChatModel } from '../llm/types.js';
import type { Retriever } from '../knowledge/retriever.js';

export interface RagAnswer {
  answer: string;
  sources: Array<{ title: string; snippet: string; score: number; sourcePath: string }>;
  mode: 'rag' | 'llm_only';
  provider: string;
}

const SYSTEM_BASE =
  '你是研究院门口的 AI 虚拟接待员。用简体中文、礼貌、简洁地回答参观与院内业务相关问题。优先依据提供的企业知识；知识不足时明确说明并给出可操作建议。避免编造不确定的数据。';

export async function answerQuestion(
  retriever: Retriever,
  model: ChatModel,
  message: string,
  topK = 4,
): Promise<RagAnswer> {
  const hits = retriever.retrieve(message, topK);
  const messages: ChatMessage[] = [];

  if (hits.length > 0) {
    const contextBlock = hits
      .map((h, i) => `【片段 ${i + 1}｜${h.title}｜${h.sourcePath}】\n${h.text}`)
      .join('\n\n');
    messages.push({
      role: 'system',
      content: `${SYSTEM_BASE}\n\n【企业知识】\n${contextBlock}`,
    });
  } else {
    messages.push({ role: 'system', content: `${SYSTEM_BASE}\n\n【企业知识】\n（无命中片段）` });
  }

  messages.push({ role: 'user', content: message });

  const result = await model.complete({ messages });

  return {
    answer: result.content,
    sources: hits.map((h) => ({
      title: h.title,
      snippet: h.text.slice(0, 160),
      score: Number(h.score.toFixed(4)),
      sourcePath: h.sourcePath,
    })),
    mode: hits.length > 0 ? 'rag' : 'llm_only',
    provider: result.provider,
  };
}
