package com.znwd.hostess.web;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.core.task.TaskExecutor;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import com.znwd.hostess.analytics.Analytics;
import com.znwd.hostess.config.AppProperties;
import com.znwd.hostess.domain.FeedbackEntry;
import com.znwd.hostess.http.ApiError;
import com.znwd.hostess.http.ClientGoneException;
import com.znwd.hostess.http.ClientIp;
import com.znwd.hostess.http.JsonlStore;
import com.znwd.hostess.http.RateLimiter;
import com.znwd.hostess.http.RequestParser;
import com.znwd.hostess.llm.ChatMessage;
import com.znwd.hostess.rag.ChatRunService;
import com.znwd.hostess.session.SessionStore;

/** 问答与会话接口：/api/chat、/api/chat/stream（SSE）、/api/sessions、/api/feedback。 */
@RestController
public class ChatController {

    private static final Logger log = LoggerFactory.getLogger(ChatController.class);

    /** 模型思考期长时，避免中间设备/代理把连接判为僵死 */
    private static final long HEARTBEAT_SECONDS = 15;

    /** 会话访问令牌的载体名：响应字段与查询参数同名，头按 HTTP 惯例加 X- 前缀 */
    public static final String SESSION_TOKEN_HEADER = "X-Session-Token";

    private final ChatRunService chat;
    private final SessionStore sessions;
    private final Analytics analytics;
    private final RateLimiter limiter;
    private final RateLimiter feedbackLimiter;
    private final JsonlStore logStore;
    private final AppProperties props;
    private final TaskExecutor sseExecutor;
    private final ScheduledExecutorService heartbeat;

    public ChatController(ChatRunService chat, SessionStore sessions, Analytics analytics,
                          @Qualifier("chatRateLimiter") RateLimiter limiter,
                          @Qualifier("feedbackRateLimiter") RateLimiter feedbackLimiter,
                          JsonlStore logStore, AppProperties props,
                          @Qualifier("sseExecutor") TaskExecutor sseExecutor,
                          ScheduledExecutorService heartbeat) {
        this.chat = chat;
        this.sessions = sessions;
        this.analytics = analytics;
        this.limiter = limiter;
        this.feedbackLimiter = feedbackLimiter;
        this.logStore = logStore;
        this.props = props;
        this.sseExecutor = sseExecutor;
        this.heartbeat = heartbeat;
    }

    @PostMapping("/api/chat")
    public Map<String, Object> chat(@RequestBody(required = false) Object body, HttpServletRequest request) {
        rateLimit(limiter, request);
        RequestParser.ChatInput input = parse(body);
        long started = System.currentTimeMillis();
        try {
            Map<String, Object> out = new LinkedHashMap<>(chat.run(input.message(), input.sessionId()));
            attachSessionToken(out, input.sessionId());
            return out;
        } catch (RuntimeException e) {
            log.error("[chat] 问答失败 requestId={}", RequestId.current(), e);
            chat.logError(input.sessionId(), input.message(), started, ApiError.INTERNAL_ERROR);
            throw new ApiException(org.springframework.http.HttpStatus.INTERNAL_SERVER_ERROR,
                    ApiError.INTERNAL_ERROR, "服务内部错误");
        }
    }

    @PostMapping(value = "/api/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@RequestBody(required = false) Object body, HttpServletRequest request,
                            HttpServletResponse response) {
        rateLimit(limiter, request);
        RequestParser.ChatInput input = parse(body);
        long started = System.currentTimeMillis();

        // 反代（nginx/Caddy）不得缓冲流式响应，否则前端看不到逐字效果
        response.setHeader("cache-control", "no-cache, no-transform");
        response.setHeader("x-accel-buffering", "no");
        response.setHeader("connection", "keep-alive");

        SseEmitter emitter = new SseEmitter(props.llm().streamTimeoutMs() + 30_000L);
        // 进 executor 前先取 requestId：RequestContextHolder 只在 MVC 请求线程有值，
        // 线程池里 RequestId.current() 恒为空，error 帧就对不上响应头 x-request-id。
        String requestId = RequestId.current();
        sseExecutor.execute(() -> {
            ScheduledFuture<?> ping = heartbeat.scheduleAtFixedRate(() -> {
                try {
                    emitter.send(SseEmitter.event().comment("ping"));
                } catch (Exception ignored) {
                    // 客户端已断开：SseEmitter 会自行 GC，下一次 send 失败即结束
                }
            }, HEARTBEAT_SECONDS, HEARTBEAT_SECONDS, TimeUnit.SECONDS);

            try {
                chat.stream(input.message(), input.sessionId(), new ChatRunService.StreamSink() {
                    @Override
                    public void meta(Map<String, Object> meta) {
                        send(emitter, "meta", meta);
                    }

                    @Override
                    public void delta(String text) {
                        send(emitter, "delta", Map.of("text", text));
                    }

                    @Override
                    public void done(Map<String, Object> done) {
                        // 令牌挂在最后一帧上：会话归属随回答一起交给前端（非流式挂在响应字段里）
                        Map<String, Object> payload = new LinkedHashMap<>(done);
                        attachSessionToken(payload, input.sessionId());
                        send(emitter, "done", payload);
                    }
                });
                emitter.complete();
            } catch (ClientGoneException gone) {
                // 客户端断开（关屏/切页/新提问 abort 旧流）：正常收尾，不打错误日志。
                // 中途断开时的部分回答与 chat_log 已在 ChatRunService.stream 里落过账
                // （meta/delta 断开时补账，done 帧断开时本来就已完成），这里绝不再补第二条。
                emitter.complete();
            } catch (RuntimeException e) {
                log.error("[chat] SSE 问答失败 requestId={}", requestId, e);
                chat.logError(input.sessionId(), input.message(), started, ApiError.INTERNAL_ERROR);
                try {
                    send(emitter, "error", ApiError.payload(ApiError.INTERNAL_ERROR, "服务内部错误", requestId));
                } catch (RuntimeException ignored) {
                    // 客户端已断开，错误事件也没必要再发
                }
                emitter.complete();
            } finally {
                ping.cancel(false);
            }
        });
        return emitter;
    }

    @GetMapping("/api/sessions/{sessionId}")
    public Map<String, Object> session(@PathVariable String sessionId, HttpServletRequest request) {
        String id = RequestParser.normalizeSessionId(sessionId);
        if (id == null) {
            throw ApiException.validation("sessionId is required");
        }
        requireOwned(id, request);
        SessionStore.Peek peek = sessions.peek(id);
        if (peek == null) {
            throw ApiException.notFound("session not found or expired");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", id);
        out.put("messages", peek.messages());
        out.put("lastActive", peek.lastActive());
        return out;
    }

    @DeleteMapping("/api/sessions/{sessionId}")
    public Map<String, Object> resetSession(@PathVariable String sessionId, HttpServletRequest request) {
        String id = RequestParser.normalizeSessionId(sessionId);
        if (id == null) {
            throw ApiException.validation("sessionId is required");
        }
        requireOwned(id, request);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", sessions.reset(id));
        out.put("sessionId", id);
        return out;
    }

    @PostMapping("/api/feedback")
    public Map<String, Object> feedback(
            @RequestBody(required = false) Map<String, Object> body,
            HttpServletRequest request) {
        // 反馈是无鉴权的公开写口，比 /api/chat 更容易刷（统计口径会被灌水）：走独立的、更严的限流桶
        rateLimit(feedbackLimiter, request);
        Object rating = body == null ? null : body.get("rating");
        if (!FeedbackEntry.UP.equals(rating) && !FeedbackEntry.DOWN.equals(rating)) {
            throw ApiException.validation("rating must be 'up' or 'down'");
        }
        String sessionId = RequestParser.normalizeSessionId(body.get("sessionId") instanceof String s ? s : null);
        String comment = body.get("comment") instanceof String c ? cut(c, 500) : null;
        String question = body.get("question") instanceof String q && !q.isBlank()
                ? cut(q.strip(), 200)
                : lastUserQuestion(sessionId);

        FeedbackEntry entry = new FeedbackEntry(System.currentTimeMillis(), sessionId, rating.toString(), comment, question);
        analytics.logFeedback(entry);
        Map<String, Object> log = new LinkedHashMap<>(Map.of("type", "feedback"));
        log.put("at", entry.at());
        log.put("sessionId", entry.sessionId());
        log.put("rating", entry.rating());
        log.put("comment", entry.comment());
        log.put("question", entry.question());
        logStore.append(log);
        return Map.of("ok", true);
    }

    /** 反馈未带 question 时从会话里取最后一条用户提问：保证运营看到的是真实问题 */
    private String lastUserQuestion(String sessionId) {
        if (sessionId == null) {
            return null;
        }
        SessionStore.Peek peek = sessions.peek(sessionId);
        if (peek == null) {
            return null;
        }
        List<ChatMessage> messages = peek.messages();
        for (int i = messages.size() - 1; i >= 0; i--) {
            ChatMessage m = messages.get(i);
            if (m.role() == com.znwd.hostess.llm.ChatRole.USER && m.content() != null && !m.content().isBlank()) {
                return cut(m.content().strip(), 200);
            }
        }
        return null;
    }

    /** 限流桶按端点拆开（chat / feedback 各算各的），命中回 429 并带上建议等待秒数 */
    private void rateLimit(RateLimiter bucket, HttpServletRequest request) {
        Long wait = bucket.allow(ClientIp.of(request.getHeader("x-forwarded-for"),
                request.getRemoteAddr(), props.trustForwardedFor()));
        if (wait != null) {
            throw ApiException.rateLimited(wait);
        }
    }

    /** 会话访问令牌：优先读 X-Session-Token 头，读不到再看 ?sessionToken= 查询串 */
    private String sessionToken(HttpServletRequest request) {
        String header = request.getHeader(SESSION_TOKEN_HEADER);
        if (header != null && !header.isBlank()) {
            return header.strip();
        }
        return request.getParameter("sessionToken");
    }

    /** 归属校验：令牌不匹配按「不存在」回 404（回 403 等于承认这个 sessionId 有效） */
    private void requireOwned(String sessionId, HttpServletRequest request) {
        if (!sessions.mayAccess(sessionId, sessionToken(request))) {
            throw ApiException.notFound("session not found or expired");
        }
    }

    /**
     * 会话令牌随问答响应下发；**每个会话至多一次**（会话首次创建的那次响应）。
     *
     * <p>之后的问答响应不再带这个字段：只拿着 sessionId（展厅大屏 localStorage 里的那个）
     * 再来一问，换不走上一位访客的令牌——详见 {@link SessionStore#issueTokenOnce}。
     * 前端对「done 帧没有 sessionToken」是容忍的（拿不到就保留已存的那枚），契约不破。
     */
    private void attachSessionToken(Map<String, Object> out, String sessionId) {
        String token = sessions.issueTokenOnce(sessionId);
        if (token != null) {
            out.put("sessionToken", token);
        }
    }

    private RequestParser.ChatInput parse(Object body) {
        RequestParser.ParseResult parsed = RequestParser.parseChatInput(body);
        if (!parsed.ok()) {
            throw ApiException.validation(RequestParser.validationMessage(parsed.reason()));
        }
        return parsed.value();
    }

    private static void send(SseEmitter emitter, String event, Object data) {
        try {
            emitter.send(SseEmitter.event().name(event).data(data, MediaType.APPLICATION_JSON));
        } catch (Exception e) {
            // 客户端断开：停止后续推送（不抛给上层，避免刷错误日志）
            throw new ClientGoneException();
        }
    }

    private static String cut(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }
}
