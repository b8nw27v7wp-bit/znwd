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
 * 多轮指代改写：仅当「本轮关键词检索拿不到达标候选」且「前面某一轮问题有达标主题」时，
 * 把那一轮命中到的主题词补进查询串。
 *
 * <p>为什么限制得这么死：
 * <ul>
 *   <li>本轮自己能检索到时不动它，避免把明确的问题改跑偏；</li>
 *   <li>前面几轮都弱时不硬接，避免拿更早的无关话题乱兜；</li>
 *   <li>只补主题词而不是整句拼接，避免长句把关键词打分按 token 数摊薄。</li>
 * </ul>
 *
 * <p>两个刻意的放宽（原实现只认「那/这/它」开头、且只看紧邻上一轮）：
 * <ul>
 *   <li>句首词表补上「刚才/刚刚/上面/前面/之前」——展厅里最自然的追问就是「刚才说的第一个方案是什么」，
 *       旧表认不出来，而整句没有域内词，直接被闸门拒答；</li>
 *   <li>往回最多看 {@link #MAX_LOOKBACK_TURNS} 轮而不是只看上一轮：上一轮本身被拒答时（「再详细说说」），
 *       主题其实在再上一轮，旧实现在这一步直接放弃。</li>
 * </ul>
 *
 * <p>判定「哪一轮有主题」用的分与检索闸门同一口径（排序分），否则会出现「闸门说这轮有主题、
 * 改写器说没有」这类两套口径打架的情况。
 */
public final class QueryRewriter {

    /** 省略式追问的常见开头 */
    private static final Pattern ELLIPSIS_HEAD = Pattern.compile(
            "^(那|那么|那个|那些|这|这个|这些|它|它们|他|她|还有|另外|再|其他|别的|继续|然后"
                    + "|刚才|刚刚|刚说|你刚|上面|上述|上文|前面|前边|之前)");

    public static final int MAX_ELLIPSIS_CHARS = 24;
    public static final int MAX_CARRIED_TOKENS = 4;
    /** 往回找主题时最多看几轮用户提问（含紧邻上一轮） */
    public static final int MAX_LOOKBACK_TURNS = 3;

    private QueryRewriter() {
    }

    public static RewriteResult rewrite(HybridRetriever retriever, String message, List<ChatMessage> history) {
        double minScore = retriever.stats().thresholds().minKeywordScore();

        List<RetrievedChunk> raw = retriever.retrieveKeyword(message, 8);
        if (isStrong(raw, minScore)) {
            return RewriteResult.unchanged(message, RewriteReason.NONE);
        }
        String trimmed = message.strip();
        if (trimmed.length() > MAX_ELLIPSIS_CHARS || !ELLIPSIS_HEAD.matcher(trimmed).find()) {
            return RewriteResult.unchanged(message, RewriteReason.NONE);
        }

        List<ChatMessage> prevUsers = lastUserMessages(history, MAX_LOOKBACK_TURNS);
        if (prevUsers.isEmpty()) {
            return RewriteResult.unchanged(message, RewriteReason.NO_HISTORY);
        }
        for (ChatMessage prev : prevUsers) {
            List<RetrievedChunk> prevHits = retriever.retrieveKeyword(prev.content(), 8);
            RetrievedChunk best = bestByScore(prevHits, minScore);
            if (best == null) {
                continue;
            }
            List<String> tokens = new ArrayList<>();
            for (String token : best.matched()) {
                if (tokens.size() >= MAX_CARRIED_TOKENS) {
                    break;
                }
                tokens.add(token);
            }
            if (tokens.isEmpty()) {
                continue;
            }
            return new RewriteResult(trimmed + " " + String.join(" ", tokens), true,
                    RewriteReason.ELLIPSIS_MERGED, tokens, best.chunk().title());
        }
        return RewriteResult.unchanged(message, RewriteReason.PREV_WEAK);
    }

    /** 这一轮自己能不能过闸门：用排序分判定，与检索闸门同一口径 */
    private static boolean isStrong(List<RetrievedChunk> hits, double minScore) {
        return !hits.isEmpty() && hits.stream().anyMatch(h -> h.score() >= minScore);
    }

    /** 候选里排序分最高的那条；都不过阈值返回 null */
    private static RetrievedChunk bestByScore(List<RetrievedChunk> hits, double minScore) {
        RetrievedChunk best = null;
        for (RetrievedChunk h : hits) {
            if (h.score() < minScore) {
                continue;
            }
            if (best == null || h.score() > best.score()) {
                best = h;
            }
        }
        return best;
    }

    /** 最近的若干条用户提问，新的在前 */
    private static List<ChatMessage> lastUserMessages(List<ChatMessage> history, int max) {
        List<ChatMessage> out = new ArrayList<>(max);
        for (int i = history.size() - 1; i >= 0 && out.size() < max; i--) {
            ChatMessage m = history.get(i);
            if (m.role() == ChatRole.USER && m.content() != null && !m.content().isBlank()) {
                out.add(m);
            }
        }
        return out;
    }
}
