package com.znwd.hostess.rag;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.znwd.hostess.analytics.Analytics;
import com.znwd.hostess.config.KnowledgeService;
import com.znwd.hostess.domain.ChatLogEntry;
import com.znwd.hostess.http.JsonlStore;
import com.znwd.hostess.http.LruCache;
import com.znwd.hostess.http.LruCache.CachedAnswer;
import com.znwd.hostess.http.MessageLog;
import com.znwd.hostess.knowledge.HybridHit;
import com.znwd.hostess.llm.ChatMessage;
import com.znwd.hostess.llm.ChatModel;
import com.znwd.hostess.llm.LlmUsage;
import com.znwd.hostess.session.SessionStore;

/**
 * 问答应用服务：缓存 → 检索+模型 → 会话 → 统计 → 日志。
 *
 * <p>非流式与流式共用同一条链路：缓存读写、会话写回、统计与日志都只有这一份实现。
 * 老版本只有非流式写缓存，导致「流式问过的问题再走非流式仍然重算」——两个入口行为不一致最难查。
 */
public class ChatRunService {

    private final KnowledgeService knowledge;
    private final ChatModel model;
    private final SessionStore sessions;
    private final Analytics analytics;
    private final LruCache<CachedAnswer> cache;
    private final JsonlStore logStore;
    private final PromptStore prompts;
    private final RagPipeline pipeline;

    public ChatRunService(KnowledgeService knowledge, ChatModel model, SessionStore sessions, Analytics analytics,
                          LruCache<CachedAnswer> cache, JsonlStore logStore, PromptStore prompts, boolean noHitLlm) {
        this.knowledge = knowledge;
        this.model = model;
        this.sessions = sessions;
        this.analytics = analytics;
        this.cache = cache;
        this.logStore = logStore;
        this.prompts = prompts == null ? PromptStore.defaults() : prompts;
        this.pipeline = new RagPipeline(knowledge.retriever(), model, noHitLlm, this.prompts);
    }

    public RagPipeline pipeline() {
        return pipeline;
    }

    /** 非流式问答 */
    public Map<String, Object> run(String message, String sessionId) {
        ensureKnowledgeReady();
        long started = System.currentTimeMillis();
        String key = cacheKey(message);
        List<ChatMessage> history = sessions.history(sessionId);
        CachedAnswer hit = cache.get(key);

        if (hit != null && history.isEmpty() && hasText(hit.answer())) {
            String retrieval = normalizeRetrieval(hit.retrieval());
            sessions.append(sessionId, message, hit.answer());
            logChat(started, sessionId, message, hit.answer(), hit.mode(), hit.provider(), retrieval,
                    hit.noHit(), false, 0, null, null);
            return response(hit.answer(), hit.sources(), hit.mode(), hit.provider(), retrieval, sessionId, 0, true,
                    hit.noHit(), null, null);
        }

        RagAnswer result = pipeline.answer(message, history);
        String answer = result.answer();
        if (!hasText(answer)) {
            throw new IllegalStateException("LLM returned empty answer");
        }
        sessions.append(sessionId, message, answer);
        if (history.isEmpty() && hasText(answer)) {
            cache.put(key, new CachedAnswer(answer, result.sources(), result.mode(), result.provider(),
                    result.retrieval(), result.noHit()));
        }
        long latency = System.currentTimeMillis() - started;
        logChat(started, sessionId, message, answer, result.mode(), result.provider(), result.retrieval(),
                result.noHit(), result.rewrite() != null && result.rewrite().rewritten(), latency,
                result.noHit() ? message : null, result.usage());

        return response(answer, result.sources(), result.mode(), result.provider(), result.retrieval(),
                sessionId, latency, false, result.noHit(), result.rewrite(), result.usage());
    }

    /** 流式问答：meta → delta* → done */
    public void stream(String message, String sessionId, StreamSink sink) {
        ensureKnowledgeReady();
        long started = System.currentTimeMillis();
        String key = cacheKey(message);
        List<ChatMessage> history = sessions.history(sessionId);
        CachedAnswer hit = cache.get(key);

        if (hit != null && history.isEmpty() && hasText(hit.answer())) {
            String retrieval = normalizeRetrieval(hit.retrieval());
            List<RagSource> sources = asSources(hit.sources());
            // 命中缓存的前提是没有历史（单轮才进缓存），所以这里必然没有改写
            RewriteResult rewrite = RewriteResult.unchanged(message, RewriteResult.RewriteReason.NONE);
            sessions.append(sessionId, message, hit.answer());
            logChat(started, sessionId, message, hit.answer(), hit.mode(), hit.provider(), retrieval,
                    hit.noHit(), false, 0, null, null);
            sink.meta(meta(hit.mode(), sources, hit.provider(), hit.noHit(), retrieval, rewrite, sessionId));
            sink.delta(hit.answer());
            sink.done(done(hit.answer(), sources, hit.mode(), retrieval, hit.noHit(), 0, true, hit.provider(),
                    rewrite, null));
            return;
        }

        // meta 必须在模型开始吐字之前发出：前端据此渲染来源与「知识库未覆盖」提示
        List<ChatMessage> trimmed = RagPipeline.trimHistory(history);
        RagPipeline.RetrievalForMessage retrieved =
                pipeline.retrieveForMessage(message, trimmed, RagPipeline.DEFAULT_TOP_K);
        List<HybridHit> hits = retrieved.hits();
        boolean gated = hits.isEmpty() && !pipeline.noHitLlm();
        List<RagSource> sources = RagPipeline.toSources(hits);
        String provider = gated ? RagAnswer.PROVIDER_GATE : model.name();
        String mode = hits.isEmpty() ? RagAnswer.MODE_LLM_ONLY : RagAnswer.MODE_RAG;
        String retrieval = retrieved.diagnostics().mode().value();

        sink.meta(meta(mode, sources, provider, hits.isEmpty(), retrieval, retrieved.rewrite(), sessionId));

        StringBuilder full = new StringBuilder();
        if (gated) {
            String reply = prompts.noHitReply();
            full.append(reply);
            sink.delta(reply);
        } else {
            model.stream(pipeline.buildPrompt(hits, message, trimmed), delta -> {
                full.append(delta);
                sink.delta(delta);
            });
        }

        String answer = full.toString();
        if (!hasText(answer)) {
            throw new IllegalStateException("LLM stream returned empty answer");
        }
        long latency = System.currentTimeMillis() - started;
        LlmUsage usage = gated ? null : model.lastUsage();
        sessions.append(sessionId, message, answer);
        if (history.isEmpty() && hasText(answer)) {
            cache.put(key, new CachedAnswer(answer, sources, mode, provider, retrieval, hits.isEmpty()));
        }
        logChat(started, sessionId, message, answer, mode, provider, retrieval, hits.isEmpty(),
                retrieved.rewrite().rewritten(), latency, hits.isEmpty() ? message : null, usage);
        sink.done(done(answer, sources, mode, retrieval, hits.isEmpty(), latency, false, provider,
                retrieved.rewrite(), usage));
    }

    /** 请求失败也要留痕（含 messagePreview，便于事后对账） */
    public void logError(String sessionId, String message, long started, String errorCode) {
        Map<String, Object> preview = MessageLog.fields(message, logStore.previewMode());
        analytics.logChat(new ChatLogEntry(started, sessionId, RagAnswer.MODE_LLM_ONLY, model.name(),
                (String) preview.get("messagePreview"), (Integer) preview.get("messageLen"), "",
                System.currentTimeMillis() - started, false, null, false, null, null, errorCode));
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("type", "chat");
        row.put("mode", RagAnswer.MODE_LLM_ONLY);
        row.put("provider", model.name());
        row.put("sessionId", sessionId);
        row.put("message", message);
        row.put("error", errorCode);
        logStore.append(row);
    }

    private String cacheKey(String message) {
        return LruCache.answerCacheKey(message, model.name(), knowledge.retriever().generation());
    }

    private Map<String, Object> meta(String mode, List<RagSource> sources, String provider, boolean noHit,
                                     String retrieval, RewriteResult rewrite, String sessionId) {
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("mode", mode);
        meta.put("sources", sources);
        meta.put("provider", provider);
        meta.put("noHit", noHit);
        meta.put("retrieval", retrieval);
        Map<String, Object> rw = new LinkedHashMap<>();
        rw.put("rewritten", rewrite != null && rewrite.rewritten());
        rw.put("reason", rewrite == null ? "none" : rewrite.reason().value());
        rw.put("carriedTokens", rewrite == null ? List.of() : rewrite.carriedTokens());
        meta.put("rewrite", rw);
        meta.put("sessionId", sessionId);
        return meta;
    }

    private Map<String, Object> done(String answer, List<RagSource> sources, String mode, String retrieval,
                                     boolean noHit, long latencyMs, boolean cached, String provider,
                                     RewriteResult rewrite, LlmUsage usage) {
        Map<String, Object> done = new LinkedHashMap<>();
        done.put("latencyMs", latencyMs);
        done.put("answer", answer);
        done.put("sources", sources);
        done.put("mode", mode);
        done.put("provider", provider);
        done.put("noHit", noHit);
        done.put("retrieval", retrieval);
        done.put("cached", cached);
        // rewrite 必须跟着 done 一起发：前端收到 done 会用它覆盖 meta，这里漏掉就等于把
        // 「已按上下文补全提问」的标记擦掉（非流式响应一直带着它，这里补上对齐）。
        if (rewrite != null) {
            Map<String, Object> rw = new LinkedHashMap<>();
            rw.put("rewritten", rewrite.rewritten());
            rw.put("reason", rewrite.reason().value());
            rw.put("carriedTokens", rewrite.carriedTokens());
            done.put("rewrite", rw);
        }
        if (usage != null) {
            done.put("usage", usageMap(usage));
        }
        return done;
    }

    /** 非流式响应体；缺省字段不出现（与老实现的 undefined 语义一致，前端判空逻辑不变） */
    private Map<String, Object> response(String answer, Object sources, String mode, String provider, String retrieval,
                                        String sessionId, long latencyMs, boolean cached, boolean noHit,
                                        RewriteResult rewrite, LlmUsage usage) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("answer", answer);
        out.put("sources", sources == null ? List.of() : sources);
        out.put("mode", mode);
        out.put("provider", provider);
        out.put("retrieval", retrieval);
        out.put("noHit", noHit);
        out.put("sessionId", sessionId);
        out.put("latencyMs", latencyMs);
        out.put("cached", cached);
        if (rewrite != null) {
            Map<String, Object> rw = new LinkedHashMap<>();
            rw.put("rewritten", rewrite.rewritten());
            rw.put("reason", rewrite.reason().value());
            rw.put("carriedTokens", rewrite.carriedTokens());
            out.put("rewrite", rw);
        }
        if (usage != null) {
            out.put("usage", usageMap(usage));
        }
        return out;
    }

    private void logChat(long started, String sessionId, String message, String answer, String mode, String provider,
                         String retrieval, boolean noHit, boolean rewritten, long latencyMs, String question,
                         LlmUsage usage) {
        Map<String, Object> preview = MessageLog.fields(message, logStore.previewMode());
        analytics.logChat(new ChatLogEntry(started, sessionId, mode, provider,
                (String) preview.get("messagePreview"), (Integer) preview.get("messageLen"), cut(answer, 80),
                latencyMs, noHit, retrieval, rewritten, question, usage, null));

        Map<String, Object> row = new LinkedHashMap<>();
        row.put("type", "chat");
        row.put("mode", mode);
        row.put("provider", provider);
        row.put("sessionId", sessionId);
        row.put("message", message);
        row.put("answerPreview", cut(answer, 200));
        row.put("latencyMs", latencyMs);
        row.put("noHit", noHit);
        row.put("retrieval", retrieval);
        row.put("rewritten", rewritten);
        if (usage != null) {
            row.put("usage", usageMap(usage));
        }
        logStore.append(row);
    }

    private static Map<String, Object> usageMap(LlmUsage usage) {
        Map<String, Object> map = new LinkedHashMap<>();
        if (usage.promptTokens() != null) {
            map.put("promptTokens", usage.promptTokens());
        }
        if (usage.completionTokens() != null) {
            map.put("completionTokens", usage.completionTokens());
        }
        if (usage.reasoningTokens() != null) {
            map.put("reasoningTokens", usage.reasoningTokens());
        }
        if (usage.totalTokens() != null) {
            map.put("totalTokens", usage.totalTokens());
        }
        return map;
    }

    @SuppressWarnings("unchecked")
    private static List<RagSource> asSources(Object sources) {
        return sources instanceof List<?> list ? (List<RagSource>) list : List.of();
    }

    private static String normalizeRetrieval(String retrieval) {
        return "hybrid".equals(retrieval) ? "hybrid" : "keyword";
    }

    private void ensureKnowledgeReady() {
        if (!knowledge.retriever().stats().indexReady()) {
            throw new IllegalStateException("知识库尚未就绪");
        }
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private static String cut(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max);
    }

    /** SSE 事件出口：控制器实现为写帧，测试里可以是收集器 */
    public interface StreamSink {
        void meta(Map<String, Object> meta);

        void delta(String text);

        void done(Map<String, Object> done);
    }
}
