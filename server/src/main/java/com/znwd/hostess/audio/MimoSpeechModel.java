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
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
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
    /** 预算里至少要给下一次尝试留这么多，否则「重试」只是走个过场（见 {@link #sleepIfFits}） */
    private static final long MIN_ATTEMPT_MS = 1_000;

    /**
     * 响应体读取的**截止看守**：到点强关响应流（理由见 {@link #readBody}）。
     *
     * <p>全 JVM 一个就够：它只在「预算用尽而体还没读完」时才真的做一次 close，那本身就是异常路径；
     * 线程是 daemon，不会拦着 JVM 退出。
     */
    private static final ScheduledExecutorService BODY_CUTOFF =
            Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "mimo-body-cutoff");
                thread.setDaemon(true);
                return thread;
            });

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
    /** 一次合成（含全部重试）的总预算 */
    private final long timeoutMs;
    /** 一次识别（含全部重试）的总预算：整段录音比一句讲解词重，两者不该共用一个数 */
    private final long asrTimeoutMs;
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
            long asrTimeoutMs,
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
        this.asrTimeoutMs = asrTimeoutMs;
        this.maxRetries = Math.max(0, maxRetries);
        this.retryBaseMs = retryBaseMs;
        this.mapper = mapper;
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                // 不跟随重定向：请求带静态 Authorization: Bearer，30x 由 JDK 跟随时会把该头
                // 一并送到 Location 目标（网关被劫持/误配就等于把密钥送出去）。3xx 当失败上报。
                .followRedirects(HttpClient.Redirect.NEVER)
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

        JsonNode root = post(writeJson(body), timeoutMs);
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

        JsonNode root = post(writeJson(body), asrTimeoutMs);
        JsonNode content = root.path("choices").path(0).path("message").path("content");
        // 形状不对（缺字段 / null / 不是字符串）是**响应坏了**，不是「没听清」，别混进空识别里：
        // 混进去的话前端会把它计成一次误触发，而服务端日志里连原文都没有。
        if (!content.isTextual()) {
            throw new SpeechException(200, "ASR 未返回文本：" + truncate(root.toString(), 300), false);
        }
        double seconds = root.path("usage").path("seconds").asDouble(0);
        // **空文本是正常结果**：一段静音（或只有环境噪声）本来就该回空，不是上游故障。
        // 早先这里抛异常 → 路由层转 502，于是前端那条「空识别只计数、不刷『没有听清』」的路径
        // 在真实部署上永远走不到（`falseTriggers` / `bargeInRejected` 恒为 0，运营拿不到
        // 调阈值要的那组数），参观者还会在没人说话时看到一句「没有识别成功」。
        // 失败与空结果的边界因此定在这里：**响应拿得到、content 是字符串、只是没内容 = 空识别**。
        return new Recognition(content.asText("").strip(), seconds);
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

    /**
     * 读响应体（上限 {@link #MAX_RESPONSE_BYTES}），并**在预算内一定会结束**。
     *
     * <p>为什么不能只靠 {@code HttpRequest.timeout()}：它只覆盖到「响应头到达」，而
     * {@code BodyHandlers.ofInputStream()} 是流式的——体那一段（最多 8MB 的读循环）没有任何超时。
     * 上游发完头就不动（网关卡住、连接半开）时，这个读会一直挂在 socket 上，而那是一条同步
     * controller：既不感知客户端已经放弃，也不会自己超时。关流是唯一能把它叫醒的动作
     * （JDK 实现里关闭这条流会取消这次 exchange）。
     */
    private String readBody(HttpResponse<InputStream> response, long deadline) throws IOException {
        InputStream body = response.body();
        if (body == null) {
            return "";
        }
        ScheduledFuture<?> cutoff = BODY_CUTOFF.schedule(() -> closeQuietly(body),
                remainingMs(deadline), TimeUnit.MILLISECONDS);
        try {
            byte[] bytes = body.readNBytes(MAX_RESPONSE_BYTES + 1);
            if (bytes.length > MAX_RESPONSE_BYTES) {
                throw new IOException("语音响应超过 " + MAX_RESPONSE_BYTES + " 字节");
            }
            return new String(bytes, StandardCharsets.UTF_8);
        } finally {
            // 正常读完就把看守撤掉；万一它已经开火（读完与撤掉之间的窄窗），关一条已经读完的流也无害
            cutoff.cancel(false);
            closeQuietly(body);
        }
    }

    private static void closeQuietly(InputStream body) {
        try {
            body.close();
        } catch (IOException ignored) {
            // 已经关了、或连接已断：忽略
        }
    }

    private String writeJson(Object body) {
        try {
            return mapper.writeValueAsString(body);
        } catch (Exception e) {
            throw new IllegalStateException("序列化语音请求失败", e);
        }
    }

    /**
     * 发一次调用并解析 JSON。过载/限流重试：只重试「还没拿到可用响应」的失败，退避 retryBaseMs 的 1x/2x/4x…
     *
     * <p>**`budgetMs` 是这一次调用（含全部重试）的总预算**，不是单次等待上限。为什么要这么算：
     * 客户端的等待上限是硬的（合成 20s、分段识别 15s、整段识别 90s），而这条同步 controller
     * 不会因为浏览器 abort 而中断上游调用——浏览器一放弃，服务端再重试下去就只是在替一个没人要的
     * 响应花线程和上游调用。早先写的是「每次尝试各等 timeoutMs」，最坏 60s×3 + 退避 ≈ 183s。
     * 现在每次尝试最多等到「剩余预算」，退避睡不进预算就收场：失败得快的（429、连接被拒）照旧重试，
     * 卡住的不再重试到天荒地老。
     */
    private JsonNode post(String payload, long budgetMs) {
        final long deadline = System.currentTimeMillis() + Math.max(1, budgetMs);
        Exception last = null;
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                HttpRequest request = HttpRequest.newBuilder()
                        .uri(URI.create(baseUrl + "/chat/completions"))
                        .timeout(Duration.ofMillis(remainingMs(deadline)))
                        .header("content-type", "application/json")
                        .header("authorization", "Bearer " + apiKey)
                        .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8))
                        .build();
                HttpResponse<InputStream> response =
                        http.send(request, HttpResponse.BodyHandlers.ofInputStream());
                String raw = readBody(response, deadline);
                if (response.statusCode() < 200 || response.statusCode() >= 300) {
                    // 3xx 不跟随（HttpClient.Redirect.NEVER）：状态码写进文案，别让现场对着
                    // 空响应体的 302 去查 JSON 解析
                    String redirectNote = response.statusCode() >= 300 && response.statusCode() < 400
                            ? "（重定向未跟随）" : "";
                    SpeechException error = new SpeechException(response.statusCode(),
                            "语音接口 HTTP " + response.statusCode() + redirectNote + "：" + truncate(raw, 300),
                            isRetryable(response.statusCode()));
                    if (!error.retryable() || attempt == maxRetries) {
                        throw error;
                    }
                    last = error;
                    if (!sleepIfFits(backoffMs(attempt), deadline)) {
                        break;
                    }
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
                if (!sleepIfFits(backoffMs(attempt), deadline)) {
                    break;
                }
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
                if (!sleepIfFits(backoffMs(attempt), deadline)) {
                    break;
                }
            }
        }
        // 预算用尽而收场：把最后一次的原因原样抛出（保留状态码——日志里「503」与「超时」是两回事，
        // 现场看运营视图的「最近的技术问题」时正是靠这个数分辨该找网关还是该找网络）
        if (last instanceof SpeechException speechError) {
            throw speechError;
        }
        throw new SpeechException(0, "语音调用失败：" + last, true);
    }

    /**
     * 本次尝试还能等多久：预算剩下的全部。
     *
     * <p>不按「剩余 ÷ 剩余次数」平分是有意的：**第一次尝试就该拿到整个预算**。这样卡住的上游会
     * 一次耗完预算、不再重试（重试一个卡死和重试一个被拒完全不是一回事），而秒回的失败
     * （429/5xx）仍留着大把预算给后面几次。下限 1ms：{@code Duration} 不接受 0 或负数。
     */
    private static long remainingMs(long deadline) {
        return Math.max(1, deadline - System.currentTimeMillis());
    }

    /**
     * 退避睡得起就睡：**睡完还得给下一次尝试留出像样的窗口**，否则这次重试只是白等一趟。
     * 睡不起返回 false，调用方收场（用最后一次的失败原因上报）。
     */
    private static boolean sleepIfFits(long backoffMs, long deadline) {
        if (System.currentTimeMillis() + backoffMs + MIN_ATTEMPT_MS > deadline) {
            return false;
        }
        sleep(backoffMs);
        return true;
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
