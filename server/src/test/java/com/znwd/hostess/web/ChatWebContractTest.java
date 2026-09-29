package com.znwd.hostess.web;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ScheduledExecutorService;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.core.task.TaskExecutor;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import com.znwd.hostess.analytics.Analytics;
import com.znwd.hostess.config.AppProperties;
import com.znwd.hostess.http.JsonlStore;
import com.znwd.hostess.http.RateLimiter;
import com.znwd.hostess.rag.ChatRunService;
import com.znwd.hostess.session.SessionStore;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 问答与会话接口的 HTTP 契约用例（错误信封 + SSE 帧序 + 会话令牌 + 限流桶）。
 *
 * <p>这一层原来只有黑盒（{@code tools/smoke.py}、{@code tools/security.py}）覆盖，本地单测里
 * 没有对应断言，于是「错误响应没设 Content-Type 时整条错误路径退化成空体 500」「反馈与问答共用
 * 限流桶」这类问题只有跑起服务才看得见。这里把踩过的坑钉成断言，改动接口时不必再起服务发现。
 */
@WebMvcTest(controllers = ChatController.class)
@EnableConfigurationProperties(AppProperties.class)
class ChatWebContractTest {

    @Autowired
    MockMvc mvc;

    @MockitoBean
    ChatRunService chat;

    @MockitoBean
    SessionStore sessions;

    @MockitoBean
    Analytics analytics;

    @MockitoBean
    JsonlStore logStore;

    @MockitoBean(name = "chatRateLimiter")
    RateLimiter chatRateLimiter;

    @MockitoBean(name = "feedbackRateLimiter")
    RateLimiter feedbackRateLimiter;

    /**
     * 两个限流桶默认放行。
     *
     * <p>必须显式打桩：Mockito 对返回 {@code Long} 的方法默认给 **0**（不是 null），
     * 而 0 在 {@link RateLimiter#allow} 里表示「要等到这一刻才能再来」——不桩就是 429。
     */
    @BeforeEach
    void allowByDefault() {
        when(chatRateLimiter.allow(any())).thenReturn(null);
        when(feedbackRateLimiter.allow(any())).thenReturn(null);
    }

    @TestConfiguration
    static class ProbeBeans {
        /** 同步执行：SSE 的帧在请求线程里就写完，测试不必等异步调度 */
        @Bean("sseExecutor")
        TaskExecutor sseExecutor() {
            return Runnable::run;
        }

        @Bean
        ScheduledExecutorService sseHeartbeat() {
            return java.util.concurrent.Executors.newSingleThreadScheduledExecutor();
        }
    }

    /** 未知路径也走统一信封（不能让框架默认体把实现暴露出去） */
    @Test
    void unknownPathReturnsErrorEnvelope() throws Exception {
        mvc.perform(get("/api/does-not-exist"))
                .andExpect(status().isNotFound())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.error").value("not_found"))
                .andExpect(jsonPath("$.message").isNotEmpty())
                .andExpect(jsonPath("$.requestId").isNotEmpty())
                .andExpect(header().exists("x-request-id"));
    }

    /** Content-Type 不支持回 415，而不是掉进兜底 500 */
    @Test
    void unsupportedBodyTypeReturns415() throws Exception {
        mvc.perform(post("/api/chat").contentType(MediaType.TEXT_PLAIN).content("x"))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.error").value("unsupported_media_type"));
    }

    /** 用错方法回 405（带上允许的方法），不是「服务内部错误」 */
    @Test
    void wrongMethodReturns405WithAllowed() throws Exception {
        mvc.perform(put("/api/chat").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isMethodNotAllowed())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.error").value("method_not_allowed"))
                .andExpect(jsonPath("$.allowed[0]").value("POST"));
    }

    /** 缺 message 回 400 校验错，文案不指向「请求体不是 JSON」 */
    @Test
    void missingMessageReturns400ValidationError() throws Exception {
        mvc.perform(post("/api/chat").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sessionId\":\"s1\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.error").value("validation_error"));
    }

    /** 坏 JSON 与缺字段是两类问题，不能都用 chat 的文案（否则排查方向被指错） */
    @Test
    void unreadableBodyReturnsDistinctMessage() throws Exception {
        mvc.perform(post("/api/chat").contentType(MediaType.APPLICATION_JSON).content("{oops"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("validation_error"))
                .andExpect(jsonPath("$.message").value("请求体不是合法 JSON 对象"));
    }

    /** 非流式问答：把会话令牌挂在响应字段上（前端据此证明会话归自己） */
    @Test
    void chatAttachesSessionToken() throws Exception {
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("answer", "答");
        answer.put("sessionId", "s1");
        when(chat.run(any(), any())).thenReturn(answer);
        when(sessions.tokenFor("s1")).thenReturn("tok-1");

        mvc.perform(post("/api/chat").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"message\":\"你好\",\"sessionId\":\"s1\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.answer").value("答"))
                .andExpect(jsonPath("$.sessionToken").value("tok-1"));
    }

    /** 问答失败只回固定文案（内部异常名不进响应），错误码可判定 */
    @Test
    void chatFailureReturnsInternalErrorEnvelope() throws Exception {
        when(chat.run(any(), any())).thenThrow(new IllegalStateException("知识库尚未就绪"));

        mvc.perform(post("/api/chat").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"message\":\"你好\"}"))
                .andExpect(status().isInternalServerError())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.error").value("internal_error"))
                .andExpect(jsonPath("$.message").value("服务内部错误"));
    }

    /** 流式：帧序必须是 meta → delta* → done，且 done 带上会话令牌 */
    @Test
    void sseEmitsMetaDeltasDoneWithToken() throws Exception {
        org.mockito.Mockito.doAnswer(inv -> {
            ChatRunService.StreamSink sink = inv.getArgument(2);
            Map<String, Object> meta = new LinkedHashMap<>();
            meta.put("mode", "rag");
            sink.meta(meta);
            sink.delta("你");
            sink.delta("好");
            Map<String, Object> done = new LinkedHashMap<>();
            done.put("answer", "你好");
            sink.done(done);
            return null;
        }).when(chat).stream(any(), any(), any());
        when(sessions.tokenFor("s1")).thenReturn("tok-1");

        MvcResult r = mvc.perform(post("/api/chat/stream").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"message\":\"你好\",\"sessionId\":\"s1\"}"))
                .andExpect(status().isOk())
                .andReturn();

        // SSE 响应头不带 charset，MockMvc 默认按 ISO-8859-1 解码会把中文读成乱码；
        // 真实链路里 SseEmitter 写的是 UTF-8 字节，这里显式按 UTF-8 读
        String body = r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        assertThat(r.getResponse().getContentType()).contains("text/event-stream");
        assertThat(body).contains("event:meta").contains("event:delta").contains("event:done");
        assertThat(body.indexOf("event:meta")).isLessThan(body.indexOf("event:delta"));
        assertThat(body.lastIndexOf("event:delta")).isLessThan(body.indexOf("event:done"));
        assertThat(body).contains("\"answer\":\"你好\"").contains("tok-1");
        assertThat(r.getResponse().getHeader("cache-control")).contains("no-cache");
        assertThat(r.getResponse().getHeader("x-accel-buffering")).isEqualTo("no");
    }

    /** 会话归属：令牌不匹配按「不存在」回 404，不回 403（403 等于承认这个 id 有效） */
    @Test
    void sessionWithoutMatchingTokenReturns404() throws Exception {
        when(sessions.mayAccess(anyString(), any())).thenReturn(false);

        mvc.perform(get("/api/sessions/s1").header(ChatController.SESSION_TOKEN_HEADER, "wrong"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("not_found"));
    }

    /** 令牌匹配且会话存在时，读取会话拿得到消息 */
    @Test
    void sessionWithMatchingTokenReturnsMessages() throws Exception {
        when(sessions.mayAccess("s1", "tok-1")).thenReturn(true);
        when(sessions.peek("s1")).thenReturn(new SessionStore.Peek(java.util.List.of(), 123L));

        mvc.perform(get("/api/sessions/s1").header(ChatController.SESSION_TOKEN_HEADER, "tok-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.sessionId").value("s1"))
                .andExpect(jsonPath("$.lastActive").value(123));
    }

    /** 换人清上下文仍要能用（DELETE 不是管理员专属），但同样要过归属校验 */
    @Test
    void resetSessionRequiresOwnership() throws Exception {
        when(sessions.mayAccess("s1", "tok-1")).thenReturn(true);
        when(sessions.reset("s1")).thenReturn(true);

        mvc.perform(delete("/api/sessions/s1").header(ChatController.SESSION_TOKEN_HEADER, "tok-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true));
    }

    /** 反馈与问答各用各的限流桶：反馈桶打满只影响反馈，不拖累正在提问的访客 */
    @Test
    void feedbackUsesItsOwnRateLimiterBucket() throws Exception {
        when(feedbackRateLimiter.allow(any())).thenReturn(7L);

        mvc.perform(post("/api/feedback").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"rating\":\"up\",\"sessionId\":\"s1\"}"))
                .andExpect(status().isTooManyRequests())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.error").value("rate_limited"));

        // 同一次测试里紧接着提问仍应放行：反馈被刷不该把访客的提问一起限掉
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("answer", "答");
        answer.put("sessionId", "s1");
        when(chat.run(any(), any())).thenReturn(answer);
        mvc.perform(post("/api/chat").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"message\":\"你好\"}"))
                .andExpect(status().isOk());
    }

    /** 反馈取值非法回 400，不落库 */
    @Test
    void feedbackRejectsUnknownRating() throws Exception {
        mvc.perform(post("/api/feedback").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"rating\":\"meh\",\"sessionId\":\"s1\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("validation_error"));

        org.mockito.Mockito.verifyNoInteractions(analytics);
    }
}
