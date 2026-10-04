package com.znwd.hostess.embedding;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/** OpenAI 兼容 /embeddings（内网网关或 bge 等模型）。 */
public class OpenAiCompatEmbeddingProvider implements EmbeddingProvider {

    private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

    private final String baseUrl;
    private final String endpoint;
    private final String apiKey;
    private final String model;
    private final int dims;
    private final Duration timeout;
    private final HttpClient http;
    private final ObjectMapper mapper;

    public OpenAiCompatEmbeddingProvider(
            String baseUrl,
            String apiKey,
            String model,
            int dims,
            Duration timeout,
            ObjectMapper mapper) {
        if (baseUrl == null || baseUrl.isBlank()) {
            throw new EmbeddingException("EMBED_BASE_URL or LLM_BASE_URL required");
        }
        if (model == null || model.isBlank()) {
            throw new EmbeddingException("EMBED_MODEL is required");
        }
        this.baseUrl = baseUrl.strip().replaceAll("/+$", "");
        this.endpoint = canonicalEndpoint(this.baseUrl);
        this.apiKey = apiKey;
        this.model = model;
        this.dims = dims;
        this.timeout = timeout;
        this.mapper = mapper;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10))
                // 不跟随重定向：请求带静态 Authorization: Bearer，30x 由 JDK 跟随时会把该头
                // 一并送到 Location 目标（网关被劫持/误配就等于把密钥送出去）。3xx 当失败上报。
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    @Override
    public String name() {
        return "openai_compat";
    }

    @Override
    public int dims() {
        return dims;
    }

    @Override
    public boolean semantic() {
        return true;
    }

    @Override
    public String model() {
        return model;
    }

    @Override
    public String endpoint() {
        return endpoint;
    }

    @Override
    public List<float[]> embed(List<String> texts) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("model", model);
        payload.put("input", texts);
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/embeddings"))
                    .timeout(timeout)
                    .header("content-type", "application/json");
            if (apiKey != null && !apiKey.isBlank()) {
                builder.header("authorization", "Bearer " + apiKey);
            }
            HttpRequest request = builder
                    .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(payload), StandardCharsets.UTF_8))
                    .build();
            HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            String body = readResponseBody(response);
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                // 3xx 不跟随（HttpClient.Redirect.NEVER）：状态码写进文案，别当成解析失败排查
                String redirectNote = response.statusCode() >= 300 && response.statusCode() < 400
                        ? " (redirect not followed)" : "";
                throw new EmbeddingException("Embeddings HTTP " + response.statusCode() + redirectNote + ": "
                        + truncate(body, 400));
            }
            JsonNode root = mapper.readTree(body);
            JsonNode data = root.path("data");
            if (!data.isArray()) {
                throw new EmbeddingException("Embeddings response data is not an array");
            }
            float[][] ordered = new float[texts.size()][];
            int position = 0;
            for (JsonNode row : data) {
                JsonNode indexNode = row.get("index");
                int index = indexNode == null || indexNode.isNull() ? position : indexNode.asInt(-1);
                if (index < 0 || index >= ordered.length || ordered[index] != null) {
                    throw new EmbeddingException("Embeddings response has an invalid index");
                }
                JsonNode embedding = row.path("embedding");
                if (!embedding.isArray() || embedding.isEmpty()) {
                    throw new EmbeddingException("Embeddings response contains an empty embedding");
                }
                float[] vec = new float[embedding.size()];
                for (int i = 0; i < embedding.size(); i++) {
                    JsonNode value = embedding.get(i);
                    if (!value.isNumber() || !Double.isFinite(value.asDouble())) {
                        throw new EmbeddingException("Embeddings response contains a non-finite value");
                    }
                    vec[i] = (float) value.asDouble();
                    if (!Float.isFinite(vec[i])) {
                        throw new EmbeddingException("Embeddings response contains an out-of-range value");
                    }
                }
                if (dims > 0 && vec.length != dims) {
                    throw new EmbeddingException("Embeddings dimension mismatch: " + vec.length + " != " + dims);
                }
                ordered[index] = vec;
                position++;
            }
            for (float[] row : ordered) {
                if (row == null) {
                    throw new EmbeddingException("Embeddings response count mismatch");
                }
            }
            return Arrays.asList(ordered);
        } catch (EmbeddingException e) {
            throw e;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new EmbeddingException("Embeddings interrupted", e);
        } catch (Exception e) {
            throw new EmbeddingException("Embeddings failed: " + describe(e), e);
        }
    }

    private static String readResponseBody(HttpResponse<InputStream> response) throws IOException {
        InputStream input = response.body();
        if (input == null) {
            return "";
        }
        try {
            byte[] bytes = input.readNBytes(MAX_RESPONSE_BYTES + 1);
            if (bytes.length > MAX_RESPONSE_BYTES) {
                throw new EmbeddingException("Embeddings response exceeds " + MAX_RESPONSE_BYTES + " bytes");
            }
            return new String(bytes, StandardCharsets.UTF_8);
        } finally {
            input.close();
        }
    }

    /** 连接被拒这类异常在部分 JDK 上 getMessage() 是 null，日志里只剩 "Embeddings failed: null" 没法排查 */
    private static String describe(Exception e) {
        String message = e.getMessage();
        return message == null || message.isBlank()
                ? e.getClass().getSimpleName()
                : e.getClass().getSimpleName() + ": " + message;
    }

    private static String truncate(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max);
    }

    private static String canonicalEndpoint(String value) {
        try {
            return java.net.URI.create(value).normalize().toString();
        } catch (IllegalArgumentException e) {
            return value;
        }
    }
}
