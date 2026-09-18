import type { ChatMessage, ChatModel } from '../llm/types.js';
import type { HybridHit, HybridRetriever } from '../knowledge/hybridRetriever.js';
import { expandQueryText } from '../knowledge/synonyms.js';

export interface RagSource {
  title: string;
  snippet: string;
  score: number;
  sourcePath: string;
  zone?: string;
  zoneTitle?: string;
  vectorScore?: number;
  keywordScore?: number;
}

export interface RagAnswer {
  answer: string;
  sources: RagSource[];
  mode: 'rag' | 'llm_only';
  provider: string;
  retrieval: 'hybrid' | 'keyword';
  queryExpanded?: string;
}

const SYSTEM_BASE =
  '你是产品展厅的 AI 虚拟讲解员，主题为光伏清洁无人机与风场检测无人机。用简体中文、礼貌、简洁地回答产品、作业流程、服务合作与展厅参观相关问题。优先依据提供的企业知识；知识不足时明确说明并给出可操作建议。避免编造不确定的参数与承诺。回答时可分点列出资料中的关键信息。';

function toSources(hits: HybridHit[]): RagSource[] {
  return hits.map((h) => ({
    title: h.title,
    snippet: h.text.slice(0, 200),
    score: Number((h.score ?? 0).toFixed(4)),
    sourcePath: h.sourcePath,
    zone: h.zone,
    zoneTitle: h.zoneTitle,
    vectorScore: h.vectorScore,
    keywordScore: h.keywordScore,
  }));
}

function buildPrompt(
  hits: HybridHit[],
  message: string,
  history: ChatMessage[],
): ChatMessage[] {
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
  return messages;
}

export async function retrieveForMessage(
  retriever: HybridRetriever,
  message: string,
  topK = 4,
): Promise<{ hits: HybridHit[]; queryExpanded: string }> {
  const queryExpanded = expandQueryText(message);
  // hybrid 内部也会扩展一次，这里用原文保证向量路用原问题、关键词路受益于扩展
  const hits = await retriever.retrieve(message, topK);
  return { hits, queryExpanded };
}

export async function answerQuestion(
  retriever: HybridRetriever,
  model: ChatModel,
  message: string,
  options: { topK?: number; history?: ChatMessage[] } = {},
): Promise<RagAnswer> {
  const topK = options.topK ?? 4;
  const history = (options.history ?? []).slice(-12);
  const { hits } = await retrieveForMessage(retriever, message, topK);
  const messages = buildPrompt(hits, message, history);
  const result = await model.complete({ messages });

  return {
    answer: result.content,
    sources: toSources(hits),
    mode: hits.length > 0 ? 'rag' : 'llm_only',
    provider: result.provider,
    retrieval: 'hybrid',
  };
}

export async function* streamAnswer(
  retriever: HybridRetriever,
  model: ChatModel,
  message: string,
  options: { topK?: number; history?: ChatMessage[] } = {},
): AsyncGenerator<
  | { type: 'meta'; sources: RagSource[]; mode: 'rag' | 'llm_only'; provider: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; full: string }
> {
  const topK = options.topK ?? 4;
  const history = (options.history ?? []).slice(-12);
  const { hits } = await retrieveForMessage(retriever, message, topK);
  const messages = buildPrompt(hits, message, history);

  yield {
    type: 'meta',
    sources: toSources(hits),
    mode: hits.length > 0 ? 'rag' : 'llm_only',
    provider: model.name,
  };

  let full = '';
  if (model.stream) {
    for await (const delta of model.stream({ messages })) {
      full += delta;
      yield { type: 'delta', text: delta };
    }
  } else {
    const r = await model.complete({ messages });
    full = r.content;
    yield { type: 'delta', text: full };
  }
  yield { type: 'done', full };
}
