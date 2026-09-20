package com.znwd.hostess.embedding;

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

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/** OpenAI 兼容 /embeddings（内网网关或 bge 等模型）。 */
public class OpenAiCompatEmbeddingProvider implements EmbeddingProvider {

    private final String baseUrl;
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
        this.baseUrl = baseUrl.replaceAll("/$", "");
        this.apiKey = apiKey;
        this.model = model;
        this.dims = dims;
        this.timeout = timeout;
        this.mapper = mapper;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
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
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new EmbeddingException("Embeddings HTTP " + response.statusCode() + ": "
                        + truncate(response.body(), 400));
            }
            JsonNode root = mapper.readTree(response.body());
            JsonNode data = root.path("data");
            List<float[]> rows = new ArrayList<>();
            if (data.isArray()) {
                for (JsonNode row : data) {
                    JsonNode embedding = row.path("embedding");
                    float[] vec = new float[embedding.size()];
                    for (int i = 0; i < embedding.size(); i++) {
                        vec[i] = (float) embedding.get(i).asDouble();
                    }
                    rows.add(vec);
                }
            }
            if (rows.size() != texts.size()) {
                throw new EmbeddingException("Embeddings count mismatch: " + rows.size() + " != " + texts.size());
            }
            return rows;
        } catch (EmbeddingException e) {
            throw e;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new EmbeddingException("Embeddings interrupted", e);
        } catch (Exception e) {
            throw new EmbeddingException("Embeddings failed: " + e.getMessage(), e);
        }
    }

    private static String truncate(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max);
    }
}
