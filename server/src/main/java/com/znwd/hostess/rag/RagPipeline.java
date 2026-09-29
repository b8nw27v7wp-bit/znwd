package com.znwd.hostess.rag;

import java.util.ArrayList;
import java.util.List;

import com.znwd.hostess.knowledge.HybridHit;
import com.znwd.hostess.knowledge.HybridRetriever;
import com.znwd.hostess.knowledge.RetrievalDiagnostics;
import com.znwd.hostess.knowledge.RetrievalOutcome;
import com.znwd.hostess.llm.ChatMessage;
import com.znwd.hostess.llm.ChatModel;
import com.znwd.hostess.llm.LlmUsage;

/**
 * RAG 主链路：检索 → 拼 prompt → 调模型。
 *
 * <p>两个产品决策写在这里，别在别处重做：
 * <ol>
 *   <li>闸门未通过时**不调用大模型**，直接返回固定拒答（省一次调用、响应即时、措辞稳定）。
 *       需要模型措辞时把 NO_HIT_LLM 打开。拒答文案与 system prompt 的正文在
 *       {@link PromptStore}（classpath 默认 + 外部文件覆盖），不在本类里写死。</li>
 *   <li>知识不足时 system 里换成「直说没有」的指令，而不是喂几段无关片段让它硬答。</li>
 * </ol>
 */
public class RagPipeline {

    public static final int DEFAULT_TOP_K = 4;
    public static final int MAX_HISTORY_MESSAGES = 12;
    /** 来源面板的入选门槛：关键词分低于「本次最高分 × 该比例」的块不展示（0 = 不过滤） */
    public static final double SOURCE_KEEP_RATIO = 0.5;
    /** 来源里「完整分块原文」的字数上限：分块约 500 字，超长块截断，防止响应体被单条撑爆 */
    public static final int CHUNK_TEXT_MAX = 800;

    private final HybridRetriever retriever;
    private final ChatModel model;
    private final boolean noHitLlm;
    private final PromptStore prompts;

    public RagPipeline(HybridRetriever retriever, ChatModel model, boolean noHitLlm) {
        this(retriever, model, noHitLlm, PromptStore.defaults());
    }

    public RagPipeline(HybridRetriever retriever, ChatModel model, boolean noHitLlm, PromptStore prompts) {
        this.retriever = retriever;
        this.model = model;
        this.noHitLlm = noHitLlm;
        this.prompts = prompts == null ? PromptStore.defaults() : prompts;
    }

    /**
     * 命中片段 → 前端「来源」列表。
     *
     * <p>按**资料文件**去重：同一份资料的相关片段常常一次占满 topK（实测问「光伏清洁无人机怎么清洗组件」，
     * 4 条来源里 3 条同属一篇 demo 文件）。不去重的后果是来源面板里挂着 3 张同名卡片、前端 `:key` 撞车，
     * 而参观者要的是「回答引了哪几份资料」。保留闸门分最高的那条，片段内容取该文件的代表片段。
     *
     * <p>再按**量级**过滤：topK 里的尾部块常常与问题无关（实测「多久能回本」的 top2/top3 是
     * 关键词 3.89 的无关资料，而 top1 是 8.44），挂上去只会让人怀疑回答的依据。
     * 门槛用**关键词分**而不是融合分——RRF 融合分在相邻名次间几乎没有差别（0.0164 / 0.0161 / 0.0159），
     * 拿它做判据等于没有判据。
     *
     * <p>入选与去重规则之外的字段（chunkText/matchTerm/matchOffset）只是把命中的分块原文与
     * 命中位置带给前端，不改变任何入选、过滤与排序行为。
     */
    public static List<RagSource> toSources(List<HybridHit> hits) {
        double bestKeyword = hits.stream().mapToDouble(HybridHit::keywordScore).max().orElse(0);
        double floor = bestKeyword * SOURCE_KEEP_RATIO;
        List<RagSource> out = new ArrayList<>(hits.size());
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        for (HybridHit h : hits) {
            if (bestKeyword > 0 && h.keywordScore() < floor) {
                continue;
            }
            String key = h.sourcePath() == null || h.sourcePath().isBlank() ? h.title() : h.sourcePath();
            if (!seen.add(key)) {
                continue;
            }
            String chunk = chunkText(h.text());
            Match match = locateMatch(chunk, h.matched());
            out.add(new RagSource(
                    h.title(),
                    h.text().length() > 200 ? h.text().substring(0, 200) : h.text(),
                    round(h.score(), 4),
                    h.sourcePath(),
                    h.zone(),
                    h.zoneTitle(),
                    h.vectorScore(),
                    h.keywordScore(),
                    chunk,
                    match.term(),
                    match.offset()));
        }
        return out;
    }

    /** 分块原文：按 {@link #CHUNK_TEXT_MAX} 截断，防单条超长块把响应体撑爆 */
    static String chunkText(String text) {
        if (text == null) {
            return "";
        }
        return text.length() > CHUNK_TEXT_MAX ? text.substring(0, CHUNK_TEXT_MAX) : text;
    }

    /**
     * 在分块原文里定位本次命中词：取能原样出现在正文里的 matched 词条中**位置最靠前**的那个
     * （matched 里可能只有标题/展区命中、正文里没有的词，那种词定位不到，跳过）。
     *
     * <p>matched 的词条是小写化的分词（如拉丁词 pv），原文可能是 PV，所以按忽略大小写查找——
     * 逐字符 regionMatches 不改变偏移语义，中文与原文偏移严格对齐。
     */
    static Match locateMatch(String text, List<String> matched) {
        if (text == null || text.isEmpty() || matched == null || matched.isEmpty()) {
            return new Match(null, -1);
        }
        String bestTerm = null;
        int bestOffset = -1;
        for (String term : matched) {
            if (term == null || term.isEmpty()) {
                continue;
            }
            int offset = indexOfIgnoreCase(text, term);
            if (offset < 0) {
                continue;
            }
            if (bestOffset < 0 || offset < bestOffset) {
                bestOffset = offset;
                bestTerm = term;
            }
        }
        return new Match(bestTerm, bestOffset);
    }

    private static int indexOfIgnoreCase(String text, String term) {
        int max = text.length() - term.length();
        for (int i = 0; i <= max; i++) {
            if (text.regionMatches(true, i, term, 0, term.length())) {
                return i;
            }
        }
        return -1;
    }

    record Match(String term, int offset) {
    }

    /** 检索 + 指代改写（回答仍按原问题，只有检索用改写后的查询） */
    public RetrievalForMessage retrieveForMessage(String message, List<ChatMessage> history, int topK) {
        RewriteResult rewrite = QueryRewriter.rewrite(retriever, message, history);
        RetrievalOutcome outcome = retriever.retrieveWithDiagnostics(rewrite.query(), topK);
        return new RetrievalForMessage(outcome.hits(), outcome.diagnostics(), rewrite);
    }

    public RagAnswer answer(String message, List<ChatMessage> history) {
        List<ChatMessage> trimmed = history.size() > MAX_HISTORY_MESSAGES
                ? history.subList(history.size() - MAX_HISTORY_MESSAGES, history.size())
                : history;
        RetrievalForMessage retrieved = retrieveForMessage(message, trimmed, DEFAULT_TOP_K);
        List<HybridHit> hits = retrieved.hits();

        if (hits.isEmpty() && !noHitLlm) {
            return new RagAnswer(prompts.noHitReply(), List.of(), RagAnswer.MODE_LLM_ONLY, RagAnswer.PROVIDER_GATE,
                    retrieved.diagnostics().mode().value(), true, retrieved.diagnostics(), retrieved.rewrite(), null);
        }

        ChatModel.ChatCompletionResult result = model.complete(buildPrompt(hits, message, trimmed));
        return new RagAnswer(
                result.content(),
                toSources(hits),
                hits.isEmpty() ? RagAnswer.MODE_LLM_ONLY : RagAnswer.MODE_RAG,
                result.provider(),
                retrieved.diagnostics().mode().value(),
                hits.isEmpty(),
                retrieved.diagnostics(),
                retrieved.rewrite(),
                result.usage());
    }

    /**
     * 流式回答。闸门拦截时把固定回复一次性推给前端（与原实现一致：前端不必区分两种收尾方式）。
     *
     * @param onDelta 正文增量回调
     */
    public StreamOutcome stream(String message, List<ChatMessage> history, java.util.function.Consumer<String> onDelta) {
        List<ChatMessage> trimmed = history.size() > MAX_HISTORY_MESSAGES
                ? history.subList(history.size() - MAX_HISTORY_MESSAGES, history.size())
                : history;
        RetrievalForMessage retrieved = retrieveForMessage(message, trimmed, DEFAULT_TOP_K);
        List<HybridHit> hits = retrieved.hits();
        boolean gated = hits.isEmpty() && !noHitLlm;
        String provider = gated ? RagAnswer.PROVIDER_GATE : model.name();

        if (gated) {
            String reply = prompts.noHitReply();
            onDelta.accept(reply);
            return new StreamOutcome(reply, toSources(hits), RagAnswer.MODE_LLM_ONLY, provider,
                    retrieved.diagnostics().mode().value(), true, retrieved.diagnostics(), retrieved.rewrite(), null);
        }

        StringBuilder full = new StringBuilder();
        model.stream(buildPrompt(hits, message, trimmed), delta -> {
            full.append(delta);
            onDelta.accept(delta);
        });
        LlmUsage usage = model.lastUsage();
        return new StreamOutcome(
                full.toString(),
                toSources(hits),
                hits.isEmpty() ? RagAnswer.MODE_LLM_ONLY : RagAnswer.MODE_RAG,
                provider,
                retrieved.diagnostics().mode().value(),
                hits.isEmpty(),
                retrieved.diagnostics(),
                retrieved.rewrite(),
                usage);
    }

    /** 命中片段装进 system；闸门未通过时换成「直说没有」指令 */
    private static List<HybridHit> filterForPrompt(List<HybridHit> hits) {
        if (hits == null || hits.isEmpty()) {
            return List.of();
        }
        double best = hits.stream().mapToDouble(HybridHit::keywordScore).max().orElse(0);
        if (best <= 0) {
            return List.copyOf(hits);
        }
        return hits.stream().filter(hit -> hit.keywordScore() >= best * SOURCE_KEEP_RATIO).toList();
    }

    public List<ChatMessage> buildPrompt(List<HybridHit> hits, String message, List<ChatMessage> history) {
        List<ChatMessage> messages = new ArrayList<>();
        if (!hits.isEmpty()) {
            StringBuilder block = new StringBuilder();
            List<HybridHit> promptHits = filterForPrompt(hits);
            for (int i = 0; i < promptHits.size(); i++) {
                HybridHit h = promptHits.get(i);
                if (block.length() > 0) {
                    block.append("\n\n");
                }
                block.append("【片段 ").append(i + 1).append("｜").append(h.title()).append("｜")
                        .append(h.zoneTitle() == null || h.zoneTitle().isBlank() ? (h.zone() == null ? "" : h.zone()) : h.zoneTitle())
                        .append("｜").append(h.sourcePath()).append("】\n").append(h.text());
            }
            messages.add(ChatMessage.system(prompts.systemBase() + "\n\n【企业知识】\n" + block));
        } else {
            messages.add(ChatMessage.system(prompts.systemBase() + "\n\n【企业知识】\n" + prompts.noHitHint()));
        }
        for (ChatMessage turn : history) {
            if (turn.role() == com.znwd.hostess.llm.ChatRole.USER
                    || turn.role() == com.znwd.hostess.llm.ChatRole.ASSISTANT) {
                messages.add(turn);
            }
        }
        messages.add(ChatMessage.user(message));
        return messages;
    }

    /** 当前生效的拒答话术（ChatRunService 流式闸门用同一份文本） */
    public String noHitReply() {
        return prompts.noHitReply();
    }

    static double round(double value, int digits) {
        double factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }

    public boolean noHitLlm() {
        return noHitLlm;
    }

    /** 历史裁剪（只保留最近若干条，避免多轮把上下文撑爆） */
    public static List<ChatMessage> trimHistory(List<ChatMessage> history) {
        return history.size() > MAX_HISTORY_MESSAGES
                ? history.subList(history.size() - MAX_HISTORY_MESSAGES, history.size())
                : history;
    }

    public record RetrievalForMessage(List<HybridHit> hits, RetrievalDiagnostics diagnostics, RewriteResult rewrite) {
    }

    public record StreamOutcome(
            String full,
            List<RagSource> sources,
            String mode,
            String provider,
            String retrieval,
            boolean noHit,
            RetrievalDiagnostics diagnostics,
            RewriteResult rewrite,
            LlmUsage usage) {
    }
}
