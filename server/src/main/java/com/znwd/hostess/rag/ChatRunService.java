package com.znwd.hostess.rag;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.znwd.hostess.analytics.Analytics;
import com.znwd.hostess.config.KnowledgeService;
import com.znwd.hostess.domain.ChatLogEntry;
import com.znwd.hostess.http.ClientGoneException;
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

    /** 客户端中途断开时 chat_log 的错误码（schema 的 error 列，运营侧按它区分「服务故障」与「访客关页」） */
    public static final String ERROR_CLIENT_GONE = "client_gone";

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
                    hit.noHit(), false, 0, null, null, null);
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
                result.noHit() ? message : null, result.usage(), null);

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
                    hit.noHit(), false, 0, null, null, null);
            // 这条路径的 append/logChat 在发帧**之前**就完成了：客户端此刻断开，账已经落过，
            // 异常直穿到控制器收尾（catch ClientGoneException），这里绝不补第二条——
            // 否则「缓存命中 + 关屏」一问会落两条 chat_log。
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

        StringBuilder full = new StringBuilder();
        try {
            sink.meta(meta(mode, sources, provider, hits.isEmpty(), retrieval, retrieved.rewrite(), sessionId));

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
        } catch (ClientGoneException gone) {
            // 客户端中途断开（前端新提问 abort 旧流是常态交互）：本轮问答不能就这么蒸发——
            // 已生成的部分回答写回会话（下一轮追问的上下文里有它），chat_log 落一条
            // client_gone 留痕；**半截回答不进答案缓存**、也不发 done（客户端已经走了）。
            // done 帧失败不走这里：那会儿 append/logChat 已经完成，异常直穿即可。
            String partial = full.toString();
            if (hasText(partial)) {
                sessions.append(sessionId, message, partial);
            }
            logChat(started, sessionId, message, partial, mode, provider, retrieval, hits.isEmpty(),
                    retrieved.rewrite().rewritten(), System.currentTimeMillis() - started,
                    hits.isEmpty() ? message : null, null, ERROR_CLIENT_GONE);
            // 落完账继续上抛：由控制器在 catch (ClientGoneException) 里收尾（complete，不打错误日志）。
            // 刻意不在这里吞掉——吞掉就变成「流正常返回 + 客户端已死」，控制器会走到成功路径的
            // emitter.complete()，那是条从未被 tools/security.py G06/G07 走过的组合。
            throw gone;
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
                retrieved.rewrite().rewritten(), latency, hits.isEmpty() ? message : null, usage, null);
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
        meta.put("rewrite", rewriteMap(rewrite));
        meta.put("sessionId", sessionId);
        return meta;
    }

    /**
     * rewrite 字段组：meta 帧、done 帧与非流式响应三处共用（字段名与内部顺序不得变——
     * done 的 rewrite 会被前端拿去覆盖 meta，漏了就等于把「已按上下文补全提问」的标记擦掉）。
     * meta 无条件携带（没有改写时是 rewrite:null 语义的空组），done/response 仅在非 null 时携带。
     */
    private static Map<String, Object> rewriteMap(RewriteResult rewrite) {
        Map<String, Object> rw = new LinkedHashMap<>();
        rw.put("rewritten", rewrite != null && rewrite.rewritten());
        rw.put("reason", rewrite == null ? "none" : rewrite.reason().value());
        rw.put("carriedTokens", rewrite == null ? List.of() : rewrite.carriedTokens());
        return rw;
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
            done.put("rewrite", rewriteMap(rewrite));
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
            out.put("rewrite", rewriteMap(rewrite));
        }
        if (usage != null) {
            out.put("usage", usageMap(usage));
        }
        return out;
    }

    /**
     * @param error 非 null 时写进 chat_log 的 error 列与 JSONL 行（如 {@link #ERROR_CLIENT_GONE}）；
     *              成功路径传 null，字段不出现（与旧行为一致）
     */
    private void logChat(long started, String sessionId, String message, String answer, String mode, String provider,
                         String retrieval, boolean noHit, boolean rewritten, long latencyMs, String question,
                         LlmUsage usage, String error) {
        Map<String, Object> preview = MessageLog.fields(message, logStore.previewMode());
        analytics.logChat(new ChatLogEntry(started, sessionId, mode, provider,
                (String) preview.get("messagePreview"), (Integer) preview.get("messageLen"), cut(answer, 80),
                latencyMs, noHit, retrieval, rewritten, question, usage, error));

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
        if (error != null) {
            row.put("error", error);
        }
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
