package com.znwd.hostess.llm;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class OpenAiCompatChatModelTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private HttpServer server;
    private String baseUrl;
    private final AtomicInteger hits = new AtomicInteger();
    private volatile boolean firstBusinessError;
    private volatile int status = 200;
    private volatile String contentType = "application/json";
    private volatile String response = "{\"choices\":[{\"message\":{\"content\":\"ok\"}}]}";

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/chat/completions", exchange -> {
            int requestNumber = hits.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            int responseStatus = status;
            String body = firstBusinessError && requestNumber == 1
                    ? "{\"error\":{\"code\":1305,\"message\":\"busy\"}}" : response;
            if (firstBusinessError && requestNumber == 1) {
                responseStatus = 200;
            }
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", contentType);
            exchange.sendResponseHeaders(responseStatus, bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        hits.set(0);
        firstBusinessError = false;
        status = 200;
        contentType = "application/json";
        response = "{\"choices\":[{\"message\":{\"content\":\"ok\"}}]}";
    }

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    void http200业务错误会重试后成功() {
        firstBusinessError = true;
        ChatModel.ChatCompletionResult result = model(1).complete(List.of(ChatMessage.user("hello")));

        assertEquals("ok", result.content());
        assertEquals(2, hits.get());
    }

    @Test
    void 流式http200业务错误也会在输出前重试() {
        firstBusinessError = true;
        contentType = "text/event-stream";
        response = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
        List<String> deltas = new ArrayList<>();

        model(1).stream(List.of(ChatMessage.user("hello")), deltas::add);

        assertEquals(List.of("ok"), deltas);
        assertEquals(2, hits.get());
    }

    @Test
    void 流式有done但没有正文时失败() {
        contentType = "text/event-stream";
        response = "data: [DONE]\n\n";
        List<String> deltas = new ArrayList<>();

        LlmHttpException error = assertThrows(LlmHttpException.class,
                () -> model(0).stream(List.of(ChatMessage.user("hello")), deltas::add));

        assertTrue(error.getMessage().contains("empty content"));
        assertTrue(deltas.isEmpty());
    }

    @Test
    void 空响应体没有done时失败() {
        contentType = "text/event-stream";
        response = "";
        List<String> deltas = new ArrayList<>();

        LlmHttpException error = assertThrows(LlmHttpException.class,
                () -> model(0).stream(List.of(ChatMessage.user("hello")), deltas::add));

        assertTrue(error.getMessage().contains("[DONE]"));
        assertTrue(deltas.isEmpty());
    }

    @Test
    void 流式响应没有done时即使有内容也失败() {
        contentType = "text/event-stream";
        response = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n";
        List<String> deltas = new ArrayList<>();

        LlmHttpException error = assertThrows(LlmHttpException.class,
                () -> model(0).stream(List.of(ChatMessage.user("hello")), deltas::add));

        assertTrue(error.getMessage().contains("[DONE]"));
        assertEquals(List.of("partial"), deltas);
    }

    @Test
    void 非流式输出超过字符上限时失败() {
        response = "{\"choices\":[{\"message\":{\"content\":\""
                + "x".repeat(OpenAiCompatChatModel.MAX_OUTPUT_CHARS + 1) + "\"}}]}";

        LlmHttpException error = assertThrows(LlmHttpException.class,
                () -> model(0).complete(List.of(ChatMessage.user("hello"))));

        assertTrue(error.getMessage().contains("output exceeds"));
    }

    @Test
    void 响应体超过读取上限时失败() {
        response = "x".repeat(OpenAiCompatChatModel.MAX_RESPONSE_BYTES + 1);

        LlmHttpException error = assertThrows(LlmHttpException.class,
                () -> model(0).complete(List.of(ChatMessage.user("hello"))));

        assertTrue(error.getMessage().contains("exceeds"));
    }

    @Test
    void http错误响应消息只保留截断内容() {
        firstBusinessError = false;
        status = 500;
        response = "x".repeat(1000);

        LlmHttpException error = assertThrows(LlmHttpException.class,
                () -> model(0).complete(List.of(ChatMessage.user("hello"))));

        assertEquals(500, error.status());
        assertFalse(error.getMessage().contains("x".repeat(1000)));
    }

    private OpenAiCompatChatModel model(int maxRetries) {
        return new OpenAiCompatChatModel(baseUrl, "test-key", "test-model", 5_000, 5_000,
                maxRetries, 0, 0, Map.of(), MAPPER);
    }
}
