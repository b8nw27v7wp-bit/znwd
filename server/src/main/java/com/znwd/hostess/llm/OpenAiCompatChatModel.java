package com.znwd.hostess.llm;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * OpenAI 兼容 Chat Completions（可接内网网关、智谱、小米 MiMo 等）。
 *
 * <p>与网关打交道踩过的坑都在这里：
 * <ul>
 *   <li>免费/共享网关会 429/5xx 过载，或 HTTP 200 带业务错误码（智谱 1305）——都要重试；额度用尽（1303/1304）重试无用；</li>
 *   <li>推理模型的 reasoning_content 不进回答（不朗读、不计入正文），只取 content；</li>
 *   <li>LLM_EXTRA_BODY 先铺、显式字段后覆盖，避免把 model/messages/stream 改掉（MiMo 靠它关思考模式）。</li>
 * </ul>
 */
public class OpenAiCompatChatModel implements ChatModel {

    public static final String NAME = "openai_compat";

    private static final Pattern BUSINESS_CODE = Pattern.compile("\"code\"\\s*:\\s*\"?(\\d{4})\"?");
    private static final Pattern OVERLOAD_HINT =
            Pattern.compile("访问量过大|稍后再试|rate limit|too many requests|overload|temporarily unavailable",
                    Pattern.CASE_INSENSITIVE);
    private static final Pattern ERROR_FIELD = Pattern.compile("\"error\"\\s*:");
    private static final Pattern NETWORK_HINT =
            Pattern.compile("connect|network|timed out|timeout|socket|reset|closed|aborted|refused",
                    Pattern.CASE_INSENSITIVE);
    /** 可重试的业务码 */
    private static final List<String> RETRYABLE_BUSINESS_CODES = List.of("1302", "1305");
    /** 额度用尽类：重试无用，直接报错让运营去续费/换模型 */
    private static final List<String> HARD_LIMIT_CODES = List.of("1303", "1304");

    private final String baseUrl;
    private final String apiKey;
    private final String model;
    private final long timeoutMs;
    private final long streamTimeoutMs;
    private final int maxRetries;
    private final long retryBaseMs;
    private final int maxTokens;
    private final Map<String, Object> extraBody;
    private final HttpClient http;
    private final ObjectMapper mapper;

    private volatile LlmUsage lastUsage;

    public OpenAiCompatChatModel(
            String baseUrl,
            String apiKey,
            String model,
            long timeoutMs,
            long streamTimeoutMs,
            int maxRetries,
            long retryBaseMs,
            int maxTokens,
            Map<String, Object> extraBody,
            ObjectMapper mapper) {
        if (baseUrl == null || baseUrl.isBlank()) {
            throw new IllegalStateException("LLM_BASE_URL is required for openai_compat");
        }
        if (model == null || model.isBlank()) {
            throw new IllegalStateException("LLM_MODEL is required for openai_compat");
        }
        this.baseUrl = baseUrl.replaceAll("/$", "");
        this.apiKey = apiKey;
        this.model = model;
        this.timeoutMs = timeoutMs;
        this.streamTimeoutMs = streamTimeoutMs;
        this.maxRetries = Math.max(0, maxRetries);
        this.retryBaseMs = retryBaseMs;
        this.maxTokens = maxTokens;
        this.extraBody = extraBody == null ? Map.of() : extraBody;
        this.mapper = mapper;
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
    }

    @Override
    public String name() {
        return NAME;
    }

    @Override
    public LlmUsage lastUsage() {
        return lastUsage;
    }

    @Override
    public ChatModel.ChatCompletionResult complete(List<ChatMessage> messages) {
        String body = postWithRetry(payload(messages, false), timeoutMs);
        JsonNode root = readTree(body);
        JsonNode error = root.path("error");
        if (!error.isMissingNode() && !error.isNull()) {
            throw new LlmHttpException(200, error.toString(),
                    "LLM error: " + error.path("message").asText(""), null);
        }
        String content = root.path("choices").path(0).path("message").path("content").asText("").strip();
        if (content.isEmpty()) {
            throw new LlmHttpException(200, truncate(body, 300), "LLM returned empty content", null);
        }
        LlmUsage usage = pickUsage(root.path("usage"));
        if (usage != null) {
            lastUsage = usage;
        }
        return new ChatModel.ChatCompletionResult(content, NAME, usage);
    }

    @Override
    public void stream(List<ChatMessage> messages, Consumer<String> onDelta) {
        long deadline = System.currentTimeMillis() + streamTimeoutMs;
        HttpResponse<InputStream> response = postStreamWithRetry(payload(messages, true), streamTimeoutMs);
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(response.body(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (System.currentTimeMillis() > deadline) {
                    // 网关长时间不发结束帧时主动收尾，避免 SSE 连接悬死
                    break;
                }
                String trimmed = line.strip();
                if (!trimmed.startsWith("data:")) {
                    continue;
                }
                String payload = trimmed.substring(5).strip();
                if ("[DONE]".equals(payload)) {
                    return;
                }
                JsonNode node;
                try {
                    node = mapper.readTree(payload);
                } catch (Exception ignored) {
                    continue;
                }
                LlmUsage usage = pickUsage(node.path("usage"));
                if (usage != null) {
                    lastUsage = usage;
                }
                // 只取正文：reasoning_content 不进回答、不进 TTS
                String piece = node.path("choices").path(0).path("delta").path("content").asText("");
                if (!piece.isEmpty()) {
                    onDelta.accept(piece);
                }
            }
        } catch (java.io.IOException e) {
            throw new LlmHttpException(0, e.getMessage() == null ? "" : e.getMessage(),
                    "LLM stream failed: " + e.getMessage(), null);
        }
    }

    private JsonNode readTree(String body) {
        try {
            return mapper.readTree(body);
        } catch (Exception e) {
            throw new LlmHttpException(0, truncate(body, 300), "LLM 响应不是合法 JSON", null);
        }
    }

    /** 请求体：额外字段先铺，显式字段后覆盖 */
    private String payload(List<ChatMessage> messages, boolean stream) {
        Map<String, Object> body = new LinkedHashMap<>(extraBody);
        body.put("model", model);
        List<Map<String, String>> wire = new ArrayList<>(messages.size());
        for (ChatMessage m : messages) {
            wire.add(Map.of("role", m.role().value(), "content", m.content()));
        }
        body.put("messages", wire);
        body.put("temperature", 0.3);
        body.put("stream", stream);
        if (maxTokens > 0) {
            body.put("max_completion_tokens", maxTokens);
        }
        try {
            return mapper.writeValueAsString(body);
        } catch (Exception e) {
            throw new IllegalStateException("序列化 LLM 请求失败", e);
        }
    }

    private String postWithRetry(String payload, long timeout) {
        HttpResponse<String> response = send(payload, timeout);
        String peek = response.body();
        if (ERROR_FIELD.matcher(peek == null ? "" : peek).find()
                && isRetryableFailure(response.statusCode(), peek)) {
            // 有的网关用 200 包错误体
            throw new LlmHttpException(response.statusCode(), peek, "LLM business error: " + truncate(peek, 300), null);
        }
        return response.body();
    }

    /** 过载/限流重试：只重试「还没拿到可用内容」的失败；退避 1s/2s…（尊重 retry-after） */
    private HttpResponse<String> send(String payload, long timeout) {
        Exception last = null;
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                HttpRequest request = requestBuilder(timeout).POST(
                        HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8)).build();
                HttpResponse<String> response =
                        http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
                if (response.statusCode() < 200 || response.statusCode() >= 300) {
                    String body = response.body() == null ? "" : response.body();
                    LlmHttpException error = new LlmHttpException(response.statusCode(), body,
                            "LLM HTTP " + response.statusCode() + ": " + truncate(body, 300),
                            response.headers().firstValue("retry-after").orElse(null));
                    if (!isRetryableFailure(error.status(), body) || attempt == maxRetries) {
                        throw error;
                    }
                    last = error;
                    sleep(backoffMs(attempt, error.retryAfter()));
                    continue;
                }
                return response;
            } catch (LlmHttpException e) {
                if (attempt == maxRetries || !isRetryableFailure(e.status(), e.body())) {
                    throw e;
                }
                last = e;
                sleep(backoffMs(attempt, e.retryAfter()));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new LlmHttpException(0, "", "LLM 调用被中断", null);
            } catch (Exception e) {
                String message = String.valueOf(e.getMessage());
                if (attempt == maxRetries || !NETWORK_HINT.matcher(message).find()) {
                    throw new LlmHttpException(0, message, "LLM 网络调用失败：" + message, null);
                }
                last = e;
                sleep(backoffMs(attempt, null));
            }
        }
        throw new LlmHttpException(0, String.valueOf(last), "LLM 调用失败：" + last, null);
    }

    private HttpResponse<InputStream> postStreamWithRetry(String payload, long timeout) {
        Exception last = null;
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                HttpRequest request = requestBuilder(timeout).POST(
                        HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8)).build();
                HttpResponse<InputStream> response =
                        http.send(request, HttpResponse.BodyHandlers.ofInputStream());
                if (response.statusCode() < 200 || response.statusCode() >= 300) {
                    String body = new String(response.body().readAllBytes(), StandardCharsets.UTF_8);
                    LlmHttpException error = new LlmHttpException(response.statusCode(), body,
                            "LLM HTTP " + response.statusCode() + ": " + truncate(body, 300),
                            response.headers().firstValue("retry-after").orElse(null));
                    if (!isRetryableFailure(error.status(), body) || attempt == maxRetries) {
                        throw error;
                    }
                    last = error;
                    sleep(backoffMs(attempt, error.retryAfter()));
                    continue;
                }
                return response;
            } catch (LlmHttpException e) {
                if (attempt == maxRetries || !isRetryableFailure(e.status(), e.body())) {
                    throw e;
                }
                last = e;
                sleep(backoffMs(attempt, e.retryAfter()));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new LlmHttpException(0, "", "LLM 调用被中断", null);
            } catch (Exception e) {
                String message = String.valueOf(e.getMessage());
                if (attempt == maxRetries || !NETWORK_HINT.matcher(message).find()) {
                    throw new LlmHttpException(0, message, "LLM 网络调用失败：" + message, null);
                }
                last = e;
                sleep(backoffMs(attempt, null));
            }
        }
        throw new LlmHttpException(0, String.valueOf(last), "LLM 流式调用失败：" + last, null);
    }

    private HttpRequest.Builder requestBuilder(long timeout) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + "/chat/completions"))
                .timeout(Duration.ofMillis(timeout))
                .header("content-type", "application/json");
        if (apiKey != null && !apiKey.isBlank()) {
            builder.header("authorization", "Bearer " + apiKey);
        }
        return builder;
    }

    public static boolean isRetryableFailure(int status, String body) {
        String text = body == null ? "" : body;
        Matcher m = BUSINESS_CODE.matcher(text);
        String code = m.find() ? m.group(1) : null;
        if (code != null && HARD_LIMIT_CODES.contains(code)) {
            return false;
        }
        if (status == 408 || status == 429 || status >= 500) {
            return true;
        }
        if (OVERLOAD_HINT.matcher(text).find()) {
            return true;
        }
        return code != null && RETRYABLE_BUSINESS_CODES.contains(code);
    }

    private long backoffMs(int attempt, String retryAfter) {
        if (retryAfter != null) {
            try {
                long seconds = Long.parseLong(retryAfter.strip());
                if (seconds > 0) {
                    return Math.min(seconds * 1000, 15_000);
                }
            } catch (NumberFormatException ignored) {
                // 非数字的 Retry-After（HTTP 日期格式）走指数退避
            }
        }
        long exp = Math.min(retryBaseMs * (1L << attempt), 8000);
        return exp + ThreadLocalRandom.current().nextInt(300);
    }

    private void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** null 安全的 usage 解析（缺字段按 null，与原实现一致） */
    public static LlmUsage pickUsage(JsonNode usage) {
        if (usage == null || usage.isMissingNode() || usage.isNull()) {
            return null;
        }
        return new LlmUsage(
                integerOrNull(usage, "prompt_tokens"),
                integerOrNull(usage, "completion_tokens"),
                usage.path("completion_tokens_details").isMissingNode()
                        ? null
                        : integerOrNull(usage.path("completion_tokens_details"), "reasoning_tokens"),
                integerOrNull(usage, "total_tokens"));
    }

    private static Integer integerOrNull(JsonNode node, String field) {
        JsonNode value = node.path(field);
        return value.isMissingNode() || value.isNull() ? null : value.asInt();
    }

    private static String truncate(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max);
    }
}
