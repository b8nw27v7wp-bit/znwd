package com.znwd.hostess.llm;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
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
import java.util.Objects;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
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
    public static final int MAX_RESPONSE_BYTES = 1_048_576;
    public static final int MAX_STREAM_BYTES = 4_194_304;
    public static final int MAX_OUTPUT_CHARS = 32_768;

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
    private static final ScheduledExecutorService DEADLINE_WATCHDOG = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "llm-stream-deadline");
        thread.setDaemon(true);
        return thread;
    });

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

    private final ThreadLocal<LlmUsage> lastUsage = new ThreadLocal<>();

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
        this.retryBaseMs = Math.max(0, retryBaseMs);
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
        return lastUsage.get();
    }

    @Override
    public ChatModel.ChatCompletionResult complete(List<ChatMessage> messages) {
        lastUsage.remove();
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        String body = postWithRetry(payload(messages, false), deadline);
        JsonNode root = readTree(body);
        if (root == null || root.isMissingNode() || root.isNull()) {
            throw new LlmHttpException(200, truncate(body, 300), "LLM returned empty content", null);
        }
        JsonNode error = root.path("error");
        if (!error.isMissingNode() && !error.isNull()) {
            throw new LlmHttpException(200, error.toString(),
                    "LLM error: " + error.path("message").asText(""), null);
        }
        String content = root.path("choices").path(0).path("message").path("content").asText("").strip();
        if (content.isEmpty()) {
            throw new LlmHttpException(200, truncate(body, 300), "LLM returned empty content", null);
        }
        if (content.length() > MAX_OUTPUT_CHARS) {
            throw outputLimitFailure();
        }
        LlmUsage usage = pickUsage(root.path("usage"));
        if (usage != null) {
            lastUsage.set(usage);
        }
        return new ChatModel.ChatCompletionResult(content, NAME, usage);
    }

    @Override
    public void stream(List<ChatMessage> messages, Consumer<String> onDelta) {
        lastUsage.remove();
        long deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(streamTimeoutMs);
        long deadline = System.currentTimeMillis() + streamTimeoutMs;
        String requestPayload = payload(messages, true);
        Exception last = null;
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            boolean[] emitted = {false};
            try {
                HttpResponse<InputStream> response = sendOnce(requestPayload, remainingMillis(deadlineNanos));
                int status = response.statusCode();
                if (status < 200 || status >= 300) {
                    String body = readResponseBody(response, MAX_RESPONSE_BYTES);
                    throw httpFailure(status, body, response.headers().firstValue("retry-after").orElse(null));
                }
                readStream(response, delta -> {
                    emitted[0] = true;
                    onDelta.accept(delta);
                }, deadline);
                return;
            } catch (LlmHttpException e) {
                if (emitted[0] || attempt == maxRetries || !isRetryableFailure(e.status(), e.body())) {
                    throw e;
                }
                last = e;
                sleepWithinDeadline(backoffMs(attempt, e.retryAfter()), deadlineNanos);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new LlmHttpException(0, "", "LLM 调用被中断", null);
            } catch (IOException e) {
                String message = e.getMessage() == null ? "" : e.getMessage();
                if (emitted[0] || attempt == maxRetries || !NETWORK_HINT.matcher(message).find()) {
                    throw new LlmHttpException(0, message, "LLM 网络调用失败：" + message, null);
                }
                last = e;
                sleepWithinDeadline(backoffMs(attempt, null), deadlineNanos);
            }
        }
        throw new LlmHttpException(0, String.valueOf(last), "LLM 流式调用失败：" + last, null);
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

    private String postWithRetry(String payload, long deadlineNanos) {
        Exception last = null;
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                long remaining = remainingMillis(deadlineNanos);
                HttpResponse<InputStream> response = sendOnce(payload, remaining);
                String body = readResponseBody(response, MAX_RESPONSE_BYTES);
                LlmHttpException failure = responseFailure(response, body);
                if (failure != null) {
                    if (attempt < maxRetries && isRetryableFailure(failure.status(), failure.body())) {
                        last = failure;
                        sleepWithinDeadline(backoffMs(attempt, failure.retryAfter()), deadlineNanos);
                        continue;
                    }
                    throw failure;
                }
                return body;
            } catch (LlmHttpException e) {
                if (attempt == maxRetries || !isRetryableFailure(e.status(), e.body())) {
                    throw e;
                }
                last = e;
                sleepWithinDeadline(backoffMs(attempt, e.retryAfter()), deadlineNanos);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new LlmHttpException(0, "", "LLM 调用被中断", null);
            } catch (IOException e) {
                String message = e.getMessage() == null ? "" : e.getMessage();
                if (attempt == maxRetries || !NETWORK_HINT.matcher(message).find()) {
                    throw new LlmHttpException(0, message, "LLM 网络调用失败：" + message, null);
                }
                last = e;
                sleepWithinDeadline(backoffMs(attempt, null), deadlineNanos);
            } catch (Exception e) {
                String message = String.valueOf(e.getMessage());
                if (attempt == maxRetries || !NETWORK_HINT.matcher(message).find()) {
                    throw new LlmHttpException(0, message, "LLM 网络调用失败：" + message, null);
                }
                last = e;
                sleepWithinDeadline(backoffMs(attempt, null), deadlineNanos);
            }
        }
        throw new LlmHttpException(0, String.valueOf(last), "LLM 调用失败：" + last, null);
    }

    private HttpResponse<InputStream> sendOnce(String payload, long timeout)
            throws IOException, InterruptedException {
        HttpRequest request = requestBuilder(timeout).POST(
                HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8)).build();
        return http.send(request, HttpResponse.BodyHandlers.ofInputStream());
    }

    private String readResponseBody(HttpResponse<InputStream> response, int maxBytes) {
        InputStream body = response.body();
        if (body == null) {
            return "";
        }
        try {
            return readBounded(body, maxBytes, "LLM response", response.statusCode());
        } finally {
            try {
                body.close();
            } catch (IOException ignored) {
            }
        }
    }

    private String readBounded(InputStream input, int maxBytes, String label, int status) {
        try (BoundedInputStream bounded = new BoundedInputStream(input, maxBytes, label)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream(Math.min(maxBytes, 8192));
            byte[] buffer = new byte[8192];
            int read;
            while ((read = bounded.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        } catch (ResponseLimitException e) {
            throw new LlmHttpException(status, "", e.getMessage(), null);
        } catch (IOException e) {
            String message = e.getMessage() == null ? "" : e.getMessage();
            throw new LlmHttpException(0, message, "LLM response read failed: " + message, null);
        }
    }

    private void readStream(HttpResponse<InputStream> response, Consumer<String> onDelta, long deadline) {
        if (response.body() == null) {
            throw new LlmHttpException(200, "", "LLM stream returned empty response", null);
        }
        boolean done = false;
        boolean hasContent = false;
        boolean sawData = false;
        int outputChars = 0;
        StringBuilder nonSse = new StringBuilder();
        InputStream raw = response.body();
        long delay = Math.max(1, deadline - System.currentTimeMillis());
        ScheduledFuture<?> watchdog = DEADLINE_WATCHDOG.schedule(() -> {
            try {
                raw.close();
            } catch (IOException ignored) {
            }
        }, delay, TimeUnit.MILLISECONDS);
        try (InputStream input = new BoundedInputStream(raw, MAX_STREAM_BYTES, "LLM stream");
             BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (System.currentTimeMillis() > deadline) {
                    throw new LlmHttpException(0, "", "LLM stream timeout", null);
                }
                String trimmed = line.strip();
                if (trimmed.isEmpty() || trimmed.startsWith(":") || trimmed.startsWith("event:")
                        || trimmed.startsWith("id:") || trimmed.startsWith("retry:")) {
                    continue;
                }
                if (!trimmed.startsWith("data:")) {
                    if (trimmed.startsWith("{") || trimmed.startsWith("[") || nonSse.length() > 0) {
                        if (nonSse.length() + trimmed.length() + 1 > MAX_RESPONSE_BYTES) {
                            throw new LlmHttpException(200, "", "LLM stream response exceeds " + MAX_RESPONSE_BYTES + " bytes", null);
                        }
                        nonSse.append(trimmed).append('\n');
                    }
                    checkNonSseBusinessLine(trimmed);
                    continue;
                }
                sawData = true;
                String payload = trimmed.substring(5).strip();
                if ("[DONE]".equals(payload)) {
                    done = true;
                    break;
                }
                JsonNode node;
                try {
                    node = mapper.readTree(payload);
                } catch (Exception ignored) {
                    continue;
                }
                if (node == null || node.isMissingNode() || node.isNull()) {
                    continue;
                }
                if (hasBusinessErrorNode(node)) {
                    throw businessFailure(200, node.toString(), null);
                }
                LlmUsage usage = pickUsage(node.path("usage"));
                if (usage != null) {
                    lastUsage.set(usage);
                }
                String piece = node.path("choices").path(0).path("delta").path("content").asText("");
                if (!piece.isEmpty()) {
                    if (piece.length() > MAX_OUTPUT_CHARS - outputChars) {
                        throw outputLimitFailure();
                    }
                    outputChars += piece.length();
                    if (!piece.isBlank()) {
                        hasContent = true;
                    }
                    onDelta.accept(piece);
                }
            }
        } catch (ResponseLimitException e) {
            throw new LlmHttpException(200, "", e.getMessage(), null);
        } catch (IOException e) {
            String message = e.getMessage() == null ? "" : e.getMessage();
            throw new LlmHttpException(0, message, "LLM stream failed: " + message, null);
        } finally {
            watchdog.cancel(false);
        }
        if (!sawData && nonSse.length() > 0 && hasBusinessErrorResponse(nonSse.toString())) {
            throw businessFailure(200, nonSse.toString(), null);
        }
        if (!done) {
            throw new LlmHttpException(200, "", "LLM stream ended without [DONE]", null);
        }
        if (!hasContent) {
            throw new LlmHttpException(200, "", "LLM stream returned empty content", null);
        }
    }

    private void checkNonSseBusinessLine(String line) {
        if (!line.startsWith("{") && !line.startsWith("[")) {
            return;
        }
        JsonNode node;
        try {
            node = mapper.readTree(line);
        } catch (Exception ignored) {
            return;
        }
        if (hasBusinessErrorNode(node)) {
            throw businessFailure(200, node.toString(), null);
        }
    }

    private boolean hasBusinessErrorResponse(String body) {
        if (body == null || body.isBlank()) {
            return false;
        }
        try {
            return hasBusinessErrorNode(mapper.readTree(body));
        } catch (Exception ignored) {
            return ERROR_FIELD.matcher(body).find() || knownBusinessCode(body) != null;
        }
    }

    private boolean hasBusinessErrorNode(JsonNode node) {
        if (node == null || node.isMissingNode() || node.isNull()) {
            return false;
        }
        JsonNode error = node.get("error");
        if (error != null && !error.isNull()) {
            return true;
        }
        return isBusinessCode(node.path("code")) || isBusinessCode(error == null ? null : error.path("code"));
    }

    private static boolean isBusinessCode(JsonNode code) {
        return code != null && !code.isMissingNode() && !code.isNull()
                && (RETRYABLE_BUSINESS_CODES.contains(code.asText()) || HARD_LIMIT_CODES.contains(code.asText()));
    }

    private static String knownBusinessCode(String body) {
        Matcher matcher = BUSINESS_CODE.matcher(body == null ? "" : body);
        if (!matcher.find()) {
            return null;
        }
        String code = matcher.group(1);
        return RETRYABLE_BUSINESS_CODES.contains(code) || HARD_LIMIT_CODES.contains(code) ? code : null;
    }

    private LlmHttpException responseFailure(HttpResponse<InputStream> response, String body) {
        int status = response.statusCode();
        if (status < 200 || status >= 300) {
            return httpFailure(status, body, response.headers().firstValue("retry-after").orElse(null));
        }
        if (hasBusinessErrorResponse(body)) {
            return businessFailure(status, body, response.headers().firstValue("retry-after").orElse(null));
        }
        return null;
    }

    private static LlmHttpException httpFailure(int status, String body, String retryAfter) {
        String text = body == null ? "" : body;
        return new LlmHttpException(status, text, "LLM HTTP " + status + ": " + truncate(text, 300), retryAfter);
    }

    private static LlmHttpException businessFailure(int status, String body, String retryAfter) {
        String text = body == null ? "" : body;
        return new LlmHttpException(status, text, "LLM business error: " + truncate(text, 300), retryAfter);
    }

    private static LlmHttpException outputLimitFailure() {
        return new LlmHttpException(200, "", "LLM output exceeds " + MAX_OUTPUT_CHARS + " characters", null);
    }

    private static final class BoundedInputStream extends FilterInputStream {
        private final int limit;
        private final String label;
        private int count;

        private BoundedInputStream(InputStream input, int limit, String label) {
            super(Objects.requireNonNull(input, "input"));
            this.limit = limit;
            this.label = label;
        }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            int n = read(one, 0, 1);
            return n < 0 ? -1 : one[0] & 0xff;
        }

        @Override
        public int read(byte[] bytes, int offset, int length) throws IOException {
            Objects.checkFromIndexSize(offset, length, bytes.length);
            if (length == 0) {
                return 0;
            }
            int remaining = limit - count;
            if (remaining <= 0) {
                if (super.read() >= 0) {
                    throw new ResponseLimitException(label, limit);
                }
                return -1;
            }
            int allowed = Math.min(length, remaining);
            int read = super.read(bytes, offset, allowed);
            if (read > 0) {
                count += read;
            }
            return read;
        }

        @Override
        public long skip(long n) throws IOException {
            if (n <= 0) {
                return 0;
            }
            long remaining = limit - count;
            if (remaining <= 0) {
                if (super.read() >= 0) {
                    throw new ResponseLimitException(label, limit);
                }
                return 0;
            }
            long skipped = super.skip(Math.min(n, remaining));
            if (skipped > 0) {
                count += (int) skipped;
            }
            return skipped;
        }
    }

    private static final class ResponseLimitException extends IOException {
        private ResponseLimitException(String label, int limit) {
            super(label + " exceeds " + limit + " bytes");
        }
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
        if (status == 0 && NETWORK_HINT.matcher(text).find()) {
            return true;
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

    private static long remainingMillis(long deadlineNanos) {
        long remaining = TimeUnit.NANOSECONDS.toMillis(deadlineNanos - System.nanoTime());
        if (remaining <= 0) {
            throw new LlmHttpException(0, "", "LLM deadline exceeded", null);
        }
        return Math.max(1, remaining);
    }

    private void sleepWithinDeadline(long requestedMs, long deadlineNanos) {
        long remaining = TimeUnit.NANOSECONDS.toMillis(deadlineNanos - System.nanoTime());
        if (remaining <= 0) {
            throw new LlmHttpException(0, "", "LLM deadline exceeded", null);
        }
        sleep(Math.min(requestedMs, Math.max(1, remaining)));
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
