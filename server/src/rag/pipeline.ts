import type { ChatMessage, ChatModel, LlmUsage } from '../llm/types.js';
import type { HybridHit, HybridRetriever, RetrievalDiagnostics } from '../knowledge/hybridRetriever.js';
import { expandQueryText } from '../knowledge/synonyms.js';
import { rewriteForRetrieval, type RewriteResult } from './rewrite.js';

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
  /** 知识库未覆盖（相关性闸门拦截）：前端据此提示，运营据此回流补资料 */
  noHit: boolean;
  diagnostics?: RetrievalDiagnostics;
  /** 多轮指代改写信息（未改写时 reason='none'） */
  rewrite?: RewriteResult;
  /** 本次调用的 token 用量（网关返回时才有） */
  usage?: LlmUsage;
  queryExpanded?: string;
}

const SYSTEM_BASE =
  '你是产品展厅的 AI 虚拟讲解员，主题为光伏清洁无人机与风场检测无人机。用简体中文、礼貌、简洁地回答产品、作业流程、服务合作与展厅参观相关问题。优先依据提供的企业知识；知识不足时明确说明并给出可操作建议。避免编造不确定的参数与承诺。回答时可分点列出资料中的关键信息。';

/** 闸门未通过时给模型的明确指令：宁可说没有，也不要拿无关片段拼答案 */
const NO_HIT_HINT =
  '（本次未检索到相关资料。请直接说明资料中没有这部分内容，并建议参观者改问产品、作业流程、服务合作或展厅参观相关的问题；不要凭常识编造产品参数、价格或承诺。）';

/**
 * 闸门未通过时的固定回复（默认直接返回，不调用大模型）。
 * 理由：拒答文案是固定的，让模型再生成一遍纯属花钱——实测一次约 780 tokens，
 * 且展厅场景要的是稳定、即时，不是文采。需要模型措辞时设 NO_HIT_LLM=true。
 */
export const NO_HIT_REPLY =
  '抱歉，这个问题不在我的讲解范围内，资料中也没有相关内容。\n\n' +
  '我是光伏清洁无人机与风场检测无人机的虚拟讲解员，可以为您解答：\n' +
  '1. 产品相关：光伏清洁无人机、风场检测无人机的功能与特点\n' +
  '2. 作业流程：无人机巡检、清洁的具体操作方式\n' +
  '3. 服务合作：业务合作模式与服务内容\n' +
  '4. 展厅参观：展区分布与参观须知\n\n' +
  '欢迎换个角度提问。';

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
    messages.push({ role: 'system', content: `${SYSTEM_BASE}\n\n【企业知识】\n${NO_HIT_HINT}` });
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
  history: ChatMessage[] = [],
): Promise<{
  hits: HybridHit[];
  diagnostics: RetrievalDiagnostics;
  queryExpanded: string;
  rewrite: RewriteResult;
}> {
  const queryExpanded = expandQueryText(message);
  // 多轮指代：本轮关键词检索拿不到达标候选时，用上一轮主题词补全查询（检索用，回答仍按原问题）
  const rewrite = rewriteForRetrieval(retriever, message, history);
  const { hits, diagnostics } = await retriever.retrieveWithDiagnostics(rewrite.query, { topK });
  return { hits, diagnostics, queryExpanded, rewrite };
}

export async function answerQuestion(
  retriever: HybridRetriever,
  model: ChatModel,
  message: string,
  options: { topK?: number; history?: ChatMessage[]; noHitLlm?: boolean } = {},
): Promise<RagAnswer> {
  const topK = options.topK ?? 4;
  const history = (options.history ?? []).slice(-12);
  const { hits, diagnostics, rewrite } = await retrieveForMessage(retriever, message, topK, history);

  // 闸门未通过：直接给固定回复，不调用大模型（省一次调用，且响应即时、措辞稳定）
  if (hits.length === 0 && !options.noHitLlm) {
    return {
      answer: NO_HIT_REPLY,
      sources: [],
      mode: 'llm_only',
      provider: 'gate',
      retrieval: diagnostics.mode,
      noHit: true,
      diagnostics,
      rewrite,
    };
  }

  const messages = buildPrompt(hits, message, history);
  const result = await model.complete({ messages });

  return {
    answer: result.content,
    sources: toSources(hits),
    mode: hits.length > 0 ? 'rag' : 'llm_only',
    provider: result.provider,
    retrieval: diagnostics.mode,
    noHit: hits.length === 0,
    diagnostics,
    rewrite,
    usage: result.usage,
  };
}

export async function* streamAnswer(
  retriever: HybridRetriever,
  model: ChatModel,
  message: string,
  options: { topK?: number; history?: ChatMessage[]; noHitLlm?: boolean } = {},
): AsyncGenerator<
  | {
      type: 'meta';
      sources: RagSource[];
      mode: 'rag' | 'llm_only';
      provider: string;
      noHit: boolean;
      diagnostics: RetrievalDiagnostics;
      rewrite: RewriteResult;
    }
  | { type: 'delta'; text: string }
  | { type: 'done'; full: string; usage?: LlmUsage }
> {
  const topK = options.topK ?? 4;
  const history = (options.history ?? []).slice(-12);
  const { hits, diagnostics, rewrite } = await retrieveForMessage(retriever, message, topK, history);

  yield {
    type: 'meta',
    sources: toSources(hits),
    mode: hits.length > 0 ? 'rag' : 'llm_only',
    provider: hits.length === 0 && !options.noHitLlm ? 'gate' : model.name,
    noHit: hits.length === 0,
    diagnostics,
    rewrite,
  };

  // 闸门未通过：固定回复，不调用大模型
  if (hits.length === 0 && !options.noHitLlm) {
    yield { type: 'delta', text: NO_HIT_REPLY };
    yield { type: 'done', full: NO_HIT_REPLY };
    return;
  }

  const messages = buildPrompt(hits, message, history);

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
  yield { type: 'done', full, usage: model.lastUsage };
}
