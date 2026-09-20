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

    private final ChatRunService chat;
    private final SessionStore sessions;
    private final Analytics analytics;
    private final RateLimiter limiter;
    private final JsonlStore logStore;
    private final AppProperties props;
    private final TaskExecutor sseExecutor;
    private final ScheduledExecutorService heartbeat;

    public ChatController(ChatRunService chat, SessionStore sessions, Analytics analytics, RateLimiter limiter,
                          JsonlStore logStore, AppProperties props,
                          @Qualifier("sseExecutor") TaskExecutor sseExecutor,
                          ScheduledExecutorService heartbeat) {
        this.chat = chat;
        this.sessions = sessions;
        this.analytics = analytics;
        this.limiter = limiter;
        this.logStore = logStore;
        this.props = props;
        this.sseExecutor = sseExecutor;
        this.heartbeat = heartbeat;
    }

    @PostMapping("/api/chat")
    public Map<String, Object> chat(@RequestBody(required = false) Object body, HttpServletRequest request) {
        rateLimit(request);
        RequestParser.ChatInput input = parse(body);
        long started = System.currentTimeMillis();
        try {
            return chat.run(input.message(), input.sessionId());
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
        rateLimit(request);
        RequestParser.ChatInput input = parse(body);

        // 反代（nginx/Caddy）不得缓冲流式响应，否则前端看不到逐字效果
        response.setHeader("cache-control", "no-cache, no-transform");
        response.setHeader("x-accel-buffering", "no");
        response.setHeader("connection", "keep-alive");

        SseEmitter emitter = new SseEmitter(props.llm().streamTimeoutMs() + 30_000L);
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
                        send(emitter, "done", done);
                    }
                });
                emitter.complete();
            } catch (ClientGoneException gone) {
                // 客户端断开（关屏/切页）：正常收尾，不打错误日志
                emitter.complete();
            } catch (RuntimeException e) {
                log.error("[chat] SSE 问答失败 requestId={}", RequestId.current(), e);
                try {
                    send(emitter, "error", ApiError.payload(ApiError.INTERNAL_ERROR, "服务内部错误", RequestId.current()));
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
    public Map<String, Object> session(@PathVariable String sessionId) {
        String id = RequestParser.normalizeSessionId(sessionId);
        if (id == null) {
            throw ApiException.validation("sessionId is required");
        }
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
    public Map<String, Object> resetSession(@PathVariable String sessionId) {
        String id = RequestParser.normalizeSessionId(sessionId);
        if (id == null) {
            throw ApiException.validation("sessionId is required");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", sessions.reset(id));
        out.put("sessionId", id);
        return out;
    }

    @PostMapping("/api/feedback")
    public Map<String, Object> feedback(@RequestBody(required = false) Map<String, Object> body) {
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

    private void rateLimit(HttpServletRequest request) {
        Long wait = limiter.allow(clientIp(request));
        if (wait != null) {
            throw ApiException.rateLimited(wait);
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

    /** 客户端断开（关闭浏览器/切屏）——不是服务端错误，按正常收尾处理 */
    private static class ClientGoneException extends RuntimeException {
    }

    /** 反代后取真实客户端 IP：优先 X-Forwarded-For 首个地址 */
    private static String clientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("x-forwarded-for");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].strip();
        }
        String remote = request.getRemoteAddr();
        return remote == null ? "unknown" : remote;
    }

    private static String cut(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }
}
