package com.znwd.hostess.audio;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * 小米 MiMo 的语音接口（TTS + ASR，都与 chat/completions 同端点、同 key）。
 *
 * <p>踩过的坑写在这里，改代码前先看：
 * <ul>
 *   <li>两个接口都走 {@code POST /v1/chat/completions}，不是 {@code /v1/audio/*}；</li>
 *   <li><b>要合成的正文放在 {@code role=assistant} 的消息里</b>，{@code role=user} 那条是风格指令
 *       （「语速稍慢、像展厅讲解员」这类），顺序颠倒会得到一段把指令念出来的音频；</li>
 *   <li>ASR 只认 {@code mp3}/{@code wav} 容器，且音频必须走 {@code data:} URL 形式的 base64
 *       （浏览器 MediaRecorder 默认吐 webm/opus，直接被拒——前端因此自己采 PCM 拼 WAV）；</li>
 *   <li>返回的音频在 {@code choices[0].message.audio.data}，不是 {@code content}，content 是空串。</li>
 * </ul>
 */
public class MimoSpeechModel implements SpeechModel {

    public static final String NAME = "mimo";
    private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
    private static final int MAX_AUDIO_BYTES = 4 * 1024 * 1024;

    /** 网络类失败的关键词：与 llm 包同款判定，避免两处行为不一致 */
    private static final Pattern NETWORK_HINT =
            Pattern.compile("connect|network|timed out|timeout|socket|reset|closed|aborted|refused",
                    Pattern.CASE_INSENSITIVE);

    private final String baseUrl;
    private final String apiKey;
    private final String ttsModel;
    private final String ttsVoice;
    private final String ttsStyle;
    private final String asrModel;
    private final String asrLanguage;
    private final long timeoutMs;
    private final int maxRetries;
    private final long retryBaseMs;
    private final HttpClient http;
    private final ObjectMapper mapper;

    public MimoSpeechModel(
            String baseUrl,
            String apiKey,
            String ttsModel,
            String ttsVoice,
            String ttsStyle,
            String asrModel,
            String asrLanguage,
            long timeoutMs,
            int maxRetries,
            long retryBaseMs,
            ObjectMapper mapper) {
        if (baseUrl == null || baseUrl.isBlank()) {
            throw new IllegalStateException("语音接口需要 base-url（可回落 LLM_BASE_URL）");
        }
        this.baseUrl = baseUrl.replaceAll("/$", "");
        this.apiKey = apiKey;
        this.ttsModel = ttsModel;
        this.ttsVoice = ttsVoice;
        this.ttsStyle = ttsStyle;
        this.asrModel = asrModel;
        this.asrLanguage = asrLanguage == null || asrLanguage.isBlank() ? "auto" : asrLanguage;
        this.timeoutMs = timeoutMs;
        this.maxRetries = Math.max(0, maxRetries);
        this.retryBaseMs = retryBaseMs;
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
    public byte[] synthesize(String text) {
        if (text == null || text.isBlank()) {
            throw new SpeechException(400, "synthesize 的文本为空", false);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", ttsModel);
        List<Map<String, String>> messages = new ArrayList<>(2);
        if (ttsStyle != null && !ttsStyle.isBlank()) {
            messages.add(Map.of("role", "user", "content", ttsStyle));
        }
        messages.add(Map.of("role", "assistant", "content", text));
        body.put("messages", messages);
        body.put("audio", Map.of("format", "wav", "voice", ttsVoice));

        JsonNode root = post(writeJson(body));
        JsonNode audio = root.path("choices").path(0).path("message").path("audio");
        String data = audio.path("data").asText("");
        if (data.isEmpty()) {
            throw new SpeechException(200, "TTS 未返回音频：" + truncate(root.toString(), 300), false);
        }
        byte[] wav = decodeBase64(data);
        // 只有真拿到 RIFF 才回给前端：把 JSON 错误体当音频播出去，前端只会得到一段静音，排查更费时间
        if (wav.length > MAX_AUDIO_BYTES || !SpeechParser.isWav(wav)) {
            throw new SpeechException(200, "TTS 返回的不是 WAV 数据", false);
        }
        return wav;
    }

    @Override
    public Recognition recognize(byte[] wav) {
        if (wav == null || wav.length == 0) {
            throw new SpeechException(400, "recognize 的音频为空", false);
        }
        String dataUrl = "data:audio/wav;base64," + Base64.getEncoder().encodeToString(wav);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", asrModel);
        body.put("messages", List.of(Map.of(
                "role", "user",
                "content", List.of(Map.of(
                        "type", "input_audio",
                        "input_audio", Map.of("data", dataUrl))))));
        body.put("asr_options", Map.of("language", asrLanguage));

        JsonNode root = post(writeJson(body));
        String text = root.path("choices").path(0).path("message").path("content").asText("").strip();
        if (text.isEmpty()) {
            throw new SpeechException(200, "ASR 未返回文本：" + truncate(root.toString(), 300), false);
        }
        double seconds = root.path("usage").path("seconds").asDouble(0);
        return new Recognition(text, seconds);
    }

    /** 有的实现会把 data URL 前缀一起塞进 data 字段 */
    private static byte[] decodeBase64(String data) {
        String raw = data.startsWith("data:") ? data.substring(data.indexOf(',') + 1) : data;
        try {
            return Base64.getDecoder().decode(raw.replaceAll("\\s", ""));
        } catch (IllegalArgumentException e) {
            throw new SpeechException(200, "音频 base64 解析失败：" + e.getMessage(), false);
        }
    }

    private static String readResponseBody(HttpResponse<InputStream> response) throws IOException {
        InputStream body = response.body();
        if (body == null) {
            return "";
        }
        try {
            byte[] bytes = body.readNBytes(MAX_RESPONSE_BYTES + 1);
            if (bytes.length > MAX_RESPONSE_BYTES) {
                throw new IOException("语音响应超过 " + MAX_RESPONSE_BYTES + " 字节");
            }
            return new String(bytes, StandardCharsets.UTF_8);
        } finally {
            body.close();
        }
    }

    private String writeJson(Object body) {
        try {
            return mapper.writeValueAsString(body);
        } catch (Exception e) {
            throw new IllegalStateException("序列化语音请求失败", e);
        }
    }

    /** 过载/限流重试：只重试「还没拿到可用响应」的失败，退避 retryBaseMs 的 1x/2x/4x… */
    private JsonNode post(String payload) {
        Exception last = null;
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                HttpRequest request = HttpRequest.newBuilder()
                        .uri(URI.create(baseUrl + "/chat/completions"))
                        .timeout(Duration.ofMillis(timeoutMs))
                        .header("content-type", "application/json")
                        .header("authorization", "Bearer " + apiKey)
                        .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8))
                        .build();
                HttpResponse<InputStream> response =
                        http.send(request, HttpResponse.BodyHandlers.ofInputStream());
                String raw = readResponseBody(response);
                if (response.statusCode() < 200 || response.statusCode() >= 300) {
                    SpeechException error = new SpeechException(response.statusCode(),
                            "语音接口 HTTP " + response.statusCode() + "：" + truncate(raw, 300),
                            isRetryable(response.statusCode()));
                    if (!error.retryable() || attempt == maxRetries) {
                        throw error;
                    }
                    last = error;
                    sleep(backoffMs(attempt));
                    continue;
                }
                try {
                    return mapper.readTree(raw);
                } catch (Exception e) {
                    throw new SpeechException(200, "语音接口响应不是合法 JSON：" + truncate(raw, 300), false);
                }
            } catch (SpeechException e) {
                if (attempt == maxRetries || !e.retryable()) {
                    throw e;
                }
                last = e;
                sleep(backoffMs(attempt));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new SpeechException(0, "语音调用被中断", false);
            } catch (IOException e) {
                String message = String.valueOf(e.getMessage());
                boolean retryable = NETWORK_HINT.matcher(message).find();
                if (attempt == maxRetries || !retryable) {
                    throw new SpeechException(0, "语音网络调用失败：" + message, retryable);
                }
                last = e;
                sleep(backoffMs(attempt));
            }
        }
        throw new SpeechException(0, "语音调用失败：" + last, true);
    }

    /** 408/429/5xx 重试有意义；4xx（参数、鉴权、额度）重试只是白等 */
    private static boolean isRetryable(int status) {
        return status == 408 || status == 429 || status >= 500;
    }

    private long backoffMs(int attempt) {
        return retryBaseMs * (1L << Math.min(attempt, 4));
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static String truncate(String text, int max) {
        if (text == null) {
            return "";
        }
        return text.length() <= max ? text : text.substring(0, max) + "…";
    }
}
