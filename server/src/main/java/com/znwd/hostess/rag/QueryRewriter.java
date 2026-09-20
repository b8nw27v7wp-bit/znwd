package com.znwd.hostess.rag;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

import com.znwd.hostess.knowledge.HybridRetriever;
import com.znwd.hostess.knowledge.RetrievedChunk;
import com.znwd.hostess.llm.ChatMessage;
import com.znwd.hostess.llm.ChatRole;
import com.znwd.hostess.rag.RewriteResult.RewriteReason;

/**
 * 多轮指代改写：仅当「本轮关键词检索拿不到达标候选」且「上一轮问题有达标主题」时，
 * 把上一轮命中到的主题词补进查询串。
 *
 * <p>为什么限制得这么死：
 * <ul>
 *   <li>本轮自己能检索到时不动它，避免把明确的问题改跑偏；</li>
 *   <li>上一轮也弱时不硬接，避免拿更早的无关话题乱兜；</li>
 *   <li>只补主题词而不是整句拼接，避免长句把关键词打分按 token 数摊薄。</li>
 * </ul>
 */
public final class QueryRewriter {

    /** 省略式追问的常见开头 */
    private static final Pattern ELLIPSIS_HEAD =
            Pattern.compile("^(那|那么|这|这个|那个|它|它们|他|她|还有|另外|再|其他|别的|继续|然后)");

    public static final int MAX_ELLIPSIS_CHARS = 20;
    public static final int MAX_CARRIED_TOKENS = 4;

    private QueryRewriter() {
    }

    public static RewriteResult rewrite(HybridRetriever retriever, String message, List<ChatMessage> history) {
        double minScore = retriever.stats().thresholds().minKeywordScore();

        List<RetrievedChunk> raw = retriever.retrieveKeyword(message, 8);
        if (!raw.isEmpty() && raw.get(0).score() >= minScore) {
            return RewriteResult.unchanged(message, RewriteReason.NONE);
        }
        String trimmed = message.strip();
        if (trimmed.length() > MAX_ELLIPSIS_CHARS || !ELLIPSIS_HEAD.matcher(trimmed).find()) {
            return RewriteResult.unchanged(message, RewriteReason.NONE);
        }

        ChatMessage prev = lastUserMessage(history);
        if (prev == null) {
            return RewriteResult.unchanged(message, RewriteReason.NO_HISTORY);
        }
        List<RetrievedChunk> prevHits = retriever.retrieveKeyword(prev.content(), 8);
        if (prevHits.isEmpty() || prevHits.get(0).score() < minScore) {
            return RewriteResult.unchanged(message, RewriteReason.PREV_WEAK);
        }
        RetrievedChunk best = prevHits.get(0);
        List<String> tokens = new ArrayList<>();
        for (String token : best.matched()) {
            if (tokens.size() >= MAX_CARRIED_TOKENS) {
                break;
            }
            tokens.add(token);
        }
        if (tokens.isEmpty()) {
            return RewriteResult.unchanged(message, RewriteReason.PREV_WEAK);
        }
        return new RewriteResult(trimmed + " " + String.join(" ", tokens), true,
                RewriteReason.ELLIPSIS_MERGED, tokens, best.chunk().title());
    }

    private static ChatMessage lastUserMessage(List<ChatMessage> history) {
        for (int i = history.size() - 1; i >= 0; i--) {
            ChatMessage m = history.get(i);
            if (m.role() == ChatRole.USER && m.content() != null && !m.content().isBlank()) {
                return m;
            }
        }
        return null;
    }
}
