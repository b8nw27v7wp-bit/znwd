package com.znwd.hostess.audio;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * MiMo 语音协议测试：对着本地假网关跑，断言的是「我们发出去的请求长什么样」与「返回怎么解」。
 *
 * <p>这几条正是最容易在真机上一次踩一个的地方：正文必须放在 assistant 消息里、音频必须走 data URL、
 * 音频不在 content 而在 message.audio.data——假网关能把它们钉死，不必每次改动都花一次真实调用去验。
 */
class MimoSpeechModelTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private HttpServer server;
    private String baseUrl;
    private final AtomicReference<String> lastBody = new AtomicReference<>("");
    private final AtomicReference<String> lastAuth = new AtomicReference<>("");
    private final AtomicInteger hits = new AtomicInteger();
    /** 重定向目标被访问的次数：非 0 就说明 HttpClient 跟随了 30x（Authorization 会被一并送出去） */
    private final AtomicInteger redirectHits = new AtomicInteger();
    /** 前 N 次调用故意失败（用来验重试），失败状态码由 failStatus 决定 */
    private final AtomicInteger failFirst = new AtomicInteger();
    private volatile int failStatus = 503;
    private volatile String location;
    private volatile String response = "{}";
    /**
     * >0 时改用「半开连接」桩：只发响应头（承诺 N 字节），一个字节的体都不发，挂这么久再断开。
     * 用来验「上游卡在响应体那一段」不会把一次调用拖过预算。
     */
    private volatile int stallSeconds;
    private final CountDownLatch stallRelease = new CountDownLatch(1);

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            hits.incrementAndGet();
            lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            lastAuth.set(String.valueOf(exchange.getRequestHeaders().getFirst("authorization")));
            if (stallSeconds > 0) {
                // 半开连接：发头 + 一个字节（**必须真的写一次体**——HttpServer 的头发送是懒的，
                // 不写体的话客户端连响应头都收不到，那测的是「没有响应」而不是「体卡住」），
                // 然后一个字节都不再发，挂住等测试收尾
                exchange.sendResponseHeaders(200, 4096);
                OutputStream stallOut = exchange.getResponseBody();
                stallOut.write('{');
                stallOut.flush();
                try {
                    stallRelease.await(stallSeconds, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                exchange.close();
                return;
            }
            int remaining = failFirst.getAndUpdate(n -> Math.max(0, n - 1));
            int status = remaining > 0 ? failStatus : 200;
            byte[] body = (status == 200 ? response : "{\"error\":{\"message\":\"busy\"}}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("content-type", "application/json");
            if (location != null) {
                exchange.getResponseHeaders().add("location", location);
            }
            exchange.sendResponseHeaders(status, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.createContext("/v1/redirect-target", exchange -> {
            redirectHits.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            byte[] bytes = "{}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/v1";
        redirectHits.set(0);
        location = null;
    }

    @AfterEach
    void stop() {
        stallRelease.countDown(); // 放掉可能还挂在半开连接上的桩线程，别让它拖着 JVM
        server.stop(0);
    }

    private MimoSpeechModel model(int maxRetries) {
        return new MimoSpeechModel(baseUrl, "test-key", "mimo-v2.5-tts", "冰糖", "用中文，语气亲切自然。",
                "mimo-v2.5-asr", "zh", 5_000, 5_000, maxRetries, 10, MAPPER);
    }

    /**
     * 自定义「一次调用的总预算」与退避：预算语义要能在毫秒级验证，不能真等几秒。
     *
     * @param budgetMs   一次调用（含重试）的总预算
     * @param retryBaseMs 退避基数（1x/2x/4x）
     */
    private MimoSpeechModel tight(int budgetMs, long retryBaseMs) {
        return new MimoSpeechModel(baseUrl, "test-key", "mimo-v2.5-tts", "冰糖", "用中文，语气亲切自然。",
                "mimo-v2.5-asr", "zh", budgetMs, budgetMs, 2, retryBaseMs, MAPPER);
    }

    private static byte[] minimalWav() {
        byte[] wav = new byte[46];
        System.arraycopy("RIFF".getBytes(), 0, wav, 0, 4);
        System.arraycopy("WAVE".getBytes(), 0, wav, 8, 4);
        System.arraycopy("fmt ".getBytes(), 0, wav, 12, 4);
        System.arraycopy("data".getBytes(), 0, wav, 36, 4);
        return wav;
    }

    private void ttsRespondsWith(byte[] wav) {
        response = "{\"choices\":[{\"message\":{\"content\":\"\",\"audio\":{\"data\":\""
                + Base64.getEncoder().encodeToString(wav) + "\"}}}]}";
    }

    // ── 合成 ──────────────────────────────────────────────────────────────

    @Test
    void 合成把正文放在assistant消息里并把风格放在user消息里() throws Exception {
        ttsRespondsWith(minimalWav());
        byte[] wav = model(0).synthesize("欢迎参观。");

        assertEquals(46, wav.length, "应原样返回 WAV 字节");
        JsonNode sent = MAPPER.readTree(lastBody.get());
        assertEquals("mimo-v2.5-tts", sent.path("model").asText());
        assertEquals("冰糖", sent.path("audio").path("voice").asText());
        assertEquals("wav", sent.path("audio").path("format").asText());
        JsonNode messages = sent.path("messages");
        // 顺序与角色都不能错：把正文放进 user 消息，模型会照着念风格指令
        assertEquals("user", messages.path(0).path("role").asText());
        assertEquals("用中文，语气亲切自然。", messages.path(0).path("content").asText());
        assertEquals("assistant", messages.path(1).path("role").asText());
        assertEquals("欢迎参观。", messages.path(1).path("content").asText());
        assertEquals("Bearer test-key", lastAuth.get());
    }

    @Test
    void 合成拿到空音频时报可判定的错误() {
        response = "{\"choices\":[{\"message\":{\"content\":\"\",\"audio\":{\"data\":\"\"}}}]}";
        SpeechException error = assertThrows(SpeechException.class, () -> model(0).synthesize("你好"));
        assertFalse(error.retryable(), "上游 200 但没给音频：重试也是白等");
        assertTrue(error.getMessage().contains("TTS 未返回音频"));
    }

    @Test
    void 合成拿到非WAV数据时拒绝而不是把垃圾当音频回给前端() {
        response = "{\"choices\":[{\"message\":{\"audio\":{\"data\":\""
                + Base64.getEncoder().encodeToString("{\"not\":\"audio\"}".getBytes()) + "\"}}}]}";
        SpeechException error = assertThrows(SpeechException.class, () -> model(0).synthesize("你好"));
        assertTrue(error.getMessage().contains("不是 WAV"));
    }

    @Test
    void 空文本不发请求() {
        assertThrows(SpeechException.class, () -> model(0).synthesize("   "));
        assertEquals(0, hits.get());
    }

    // ── 识别 ──────────────────────────────────────────────────────────────

    @Test
    void 识别用dataURL发音频并解析文本与时长() throws Exception {
        response = "{\"choices\":[{\"message\":{\"content\":\" 叶片检测要停机吗 \"}}],\"usage\":{\"seconds\":3.2}}";
        SpeechModel.Recognition recognition = model(0).recognize(minimalWav());

        assertEquals("叶片检测要停机吗", recognition.text(), "首尾空白要清掉");
        assertEquals(3.2, recognition.seconds(), 1e-6);

        JsonNode sent = MAPPER.readTree(lastBody.get());
        assertEquals("mimo-v2.5-asr", sent.path("model").asText());
        assertEquals("zh", sent.path("asr_options").path("language").asText());
        JsonNode content = sent.path("messages").path(0).path("content").path(0);
        assertEquals("input_audio", content.path("type").asText());
        String data = content.path("input_audio").path("data").asText();
        assertTrue(data.startsWith("data:audio/wav;base64,"), "ASR 只认 data URL 形式的 base64：" + data);
        assertEquals(46, Base64.getDecoder().decode(data.substring(data.indexOf(',') + 1)).length);
    }

    /**
     * 空文本是**正常结果**，不是上游故障。
     *
     * <p>这条曾经是 `assertThrows`——而抛出会被路由层转成 502，前端那条「空识别只计一次误触发、
     * 不刷『没有听清』」的路径于是在真实部署上永远走不到：`falseTriggers` / `bargeInRejected`
     * 恒为 0（运营拿不到调阈值要的那组数），参观者还会在没人说话时看到一句「没有识别成功」。
     */
    @Test
    void 识别拿到空文本时回空结果而不是报错() {
        response = "{\"choices\":[{\"message\":{\"content\":\"\"}}],\"usage\":{\"seconds\":1.5}}";
        SpeechModel.Recognition recognition = model(0).recognize(minimalWav());

        assertEquals("", recognition.text(), "静音/纯噪声：没有话就是没有话");
        assertEquals(1.5, recognition.seconds(), 1e-6, "时长照常带回来（它是「说了话」与「录到静音」的区分口径）");
    }

    /** 纯空白与空格同样算「没听到话」，不该因为 strip 之后为空又变成失败 */
    @Test
    void 识别拿到纯空白文本时也回空结果() {
        response = "{\"choices\":[{\"message\":{\"content\":\"   \\n \"}}]}";
        assertEquals("", model(0).recognize(minimalWav()).text());
    }

    /**
     * 响应**形状不对**（缺 content / null / 不是字符串）仍旧报错。
     *
     * <p>这是与「空识别」的分界线：坏响应混进空识别，前端会把它计成一次环境噪声误触发，
     * 而服务端日志里连原文都没有——调阈值的人会照着假数据改参数。
     */
    @Test
    void 识别响应缺content字段时仍报错() {
        response = "{\"choices\":[{\"message\":{\"audio\":{}}}]}";
        SpeechException error = assertThrows(SpeechException.class, () -> model(0).recognize(minimalWav()));
        assertTrue(error.getMessage().contains("ASR 未返回文本"), error.getMessage());
    }

    @Test
    void 识别响应content为null时仍报错() {
        response = "{\"choices\":[{\"message\":{\"content\":null}}]}";
        assertThrows(SpeechException.class, () -> model(0).recognize(minimalWav()));
    }

    @Test
    void 空音频不发请求() {
        assertThrows(SpeechException.class, () -> model(0).recognize(new byte[0]));
        assertEquals(0, hits.get());
    }

    // ── 重试 ──────────────────────────────────────────────────────────────

    @Test
    void 上游5xx会重试并最终成功() {
        ttsRespondsWith(minimalWav());
        failFirst.set(2);
        byte[] wav = model(2).synthesize("你好");
        assertEquals(46, wav.length);
        assertEquals(3, hits.get(), "两次失败 + 一次成功");
    }

    @Test
    void 鉴权或参数类4xx不重试() {
        failStatus = 401;
        failFirst.set(5);
        SpeechException error = assertThrows(SpeechException.class, () -> model(2).synthesize("你好"));
        assertEquals(401, error.status());
        assertEquals(1, hits.get(), "4xx 重试只是白等，还会拖长前端等待");
    }

    /**
     * 302 必须当失败上报、且绝不跟随：请求带静态 Authorization，JDK 一旦跟随就会把
     * 该头送给 Location 目标（网关被劫持/误配 = 密钥外带）。
     */
    @Test
    void http302响应报错且不跟随重定向() {
        failStatus = 302;
        failFirst.set(1);
        location = baseUrl + "/redirect-target";

        SpeechException error = assertThrows(SpeechException.class, () -> model(2).synthesize("你好"));

        assertEquals(302, error.status(), "3xx 要带状态码进错误");
        assertFalse(error.retryable(), "跟随已关闭，重发同样的 30x 毫无意义");
        assertTrue(error.getMessage().contains("302"), error.getMessage());
        assertEquals(1, hits.get());
        assertEquals(0, redirectHits.get(), "重定向目标不应被访问（否则 Authorization 已外送）");
    }

    @Test
    void 重试次数用尽后抛出最后一次原因() {
        failFirst.set(10);
        SpeechException error = assertThrows(SpeechException.class, () -> model(1).synthesize("你好"));
        assertEquals(503, error.status());
        assertEquals(2, hits.get(), "maxRetries=1 → 共两次尝试");
    }

    /**
     * 退避睡不进预算就不再重试。
     *
     * <p>预算（`AUDIO_TIMEOUT_MS` / `AUDIO_ASR_TIMEOUT_MS`）是**一次调用含全部重试**的总时长，
     * 而客户端等的就是这么久（合成 20s、分段 15s、整段 90s）。服务端比客户端还晚收场，
     * 就只是替一个没人要的响应花线程与上游调用——早先「每次尝试各等 60 秒」最坏能到 183 秒。
     *
     * <p>这里用「预算 200ms + 退避 10s」构造：失败本身秒回，但退避睡不进预算 → 只打一次。
     */
    @Test
    void 退避睡不进预算时不再重试() {
        failFirst.set(10);
        SpeechException error = assertThrows(SpeechException.class, () -> tight(200, 10_000).synthesize("你好"));
        assertEquals(1, hits.get(), "预算里塞不下这次退避，就没有第二次尝试");
        assertEquals(503, error.status(), "收场时保留最后一次的状态码，日志里才分得清 503 与超时");
        assertTrue(error.getMessage().contains("503"), error.getMessage());
    }

    /** 反之：预算够宽时秒回的失败照旧重试到上限（预算语义不能把正常重试也砍掉） */
    @Test
    void 预算够宽时秒回的失败照旧重试() {
        failFirst.set(10);
        assertThrows(SpeechException.class, () -> tight(5_000, 10).synthesize("你好"));
        assertEquals(3, hits.get(), "maxRetries=2 → 共三次尝试");
    }

    /**
     * **上游发完响应头就不发响应体**（网关卡住、连接半开）：必须在一个预算内收场。
     *
     * <p>这条盯的是 V2 修完之后剩下的那个洞：{@code HttpRequest.timeout()} 只覆盖到「响应头到达」，
     * 而 {@code BodyHandlers.ofInputStream()} 是流式的——体那一段的读循环没有任何超时。没有看守时
     * 这里会一直挂在 socket 上，直到对端自己断开（桩里给的是 6 秒），而那是一条同步 controller：
     * 既不感知客户端已经放弃，也不会自己超时。
     *
     * <p>桩用「发头 + 一个字节，然后彻底不动」模拟半开连接（**必须真的写一次体**：HttpServer 的
     * 头发送是懒的，不写体的话客户端连头都收不到，那测的是「没有响应」而不是「体卡住」——
     * 前者 JDK 的超时是管的），最多挂 6 秒就自己关掉，测试最慢 6 秒、不会把 JVM 吊死。
     *
     * <p>实测（JDK 25，预算 500ms）：**没有看守时 6070ms 才随对端断开而结束**，有看守 505ms 收场。
     * 所以这条在看守缺席时是红的（6 秒 > 上限 3 秒）。
     */
    @Test
    void 上游只发响应头不发响应体时预算内收场() throws Exception {
        stallSeconds = 6;
        long started = System.currentTimeMillis();
        assertThrows(SpeechException.class, () -> tight(500, 10_000).synthesize("你好"));
        long elapsed = System.currentTimeMillis() - started;

        assertTrue(elapsed < 3_000, "预算 500ms，实耗 " + elapsed + "ms——响应体那一段没有被看守");
        assertEquals(1, hits.get(), "卡死的上游一次耗完预算后不再重试，不能把 500ms 的预算睡成 3 次尝试");
    }
}
