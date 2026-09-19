import type { ChatMessage } from '../llm/types.js';
import type { HybridRetriever } from '../knowledge/hybridRetriever.js';

export type RewriteReason = 'none' | 'no_history' | 'prev_weak' | 'ellipsis_merged';

export interface RewriteResult {
  /** 用于检索的查询串（未改写时等于原问题） */
  query: string;
  rewritten: boolean;
  reason: RewriteReason;
  /** 从上一轮问题继承的主题词 */
  carriedTokens: string[];
  carriedTopic?: string;
}

export interface RewriteOptions {
  /** 低于该分视为「本轮没有可检索内容」 */
  minScore?: number;
  /** 超过该长度的提问不视为省略式追问 */
  maxEllipsisChars?: number;
  /** 最多继承几个主题词 */
  maxCarriedTokens?: number;
}

/** 省略式追问的常见开头 */
const ELLIPSIS_HEAD = /^(那|那么|这|这个|那个|它|它们|他|她|还有|另外|再|其他|别的|继续|然后)/;

function lastUserMessage(history: ChatMessage[]): ChatMessage | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user' && m.content.trim()) return m;
  }
  return undefined;
}

/**
 * 多轮指代改写：仅当「本轮关键词检索拿不到达标候选」且「上一轮问题有达标主题」时，
 * 把上一轮命中到的主题词补进查询串。
 *
 * 为什么这样限制：
 * - 本轮自己能检索到时不动它，避免把明确的问题改跑偏；
 * - 上一轮也弱时不硬接，避免拿更早的无关话题乱兜；
 * - 只补主题词而不是整句拼接，避免长句把关键词打分按 token 数摊薄。
 */
export function rewriteForRetrieval(
  retriever: HybridRetriever,
  message: string,
  history: ChatMessage[],
  options: RewriteOptions = {},
): RewriteResult {
  const minScore = options.minScore ?? retriever.stats().thresholds.minKeywordScore;
  const maxEllipsisChars = options.maxEllipsisChars ?? 20;
  const maxCarried = options.maxCarriedTokens ?? 4;

  const raw = retriever.retrieveKeyword(message, 8);
  if (raw.length > 0 && raw[0]!.score >= minScore) {
    return { query: message, rewritten: false, reason: 'none', carriedTokens: [] };
  }
  if (message.trim().length > maxEllipsisChars || !ELLIPSIS_HEAD.test(message.trim())) {
    return { query: message, rewritten: false, reason: 'none', carriedTokens: [] };
  }

  const prev = lastUserMessage(history);
  if (!prev) {
    return { query: message, rewritten: false, reason: 'no_history', carriedTokens: [] };
  }
  const prevHits = retriever.retrieveKeyword(prev.content, 8);
  const best = prevHits[0];
  if (!best || best.score < minScore) {
    return { query: message, rewritten: false, reason: 'prev_weak', carriedTokens: [] };
  }

  const tokens = (best.matched ?? []).slice(0, maxCarried);
  if (tokens.length === 0) {
    return { query: message, rewritten: false, reason: 'prev_weak', carriedTokens: [] };
  }
  return {
    query: `${message.trim()} ${tokens.join(' ')}`,
    rewritten: true,
    reason: 'ellipsis_merged',
    carriedTokens: tokens,
    carriedTopic: best.title,
  };
}
