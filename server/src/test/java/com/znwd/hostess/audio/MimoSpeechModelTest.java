package com.znwd.hostess.audio;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
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
    /** 前 N 次调用故意失败（用来验重试），失败状态码由 failStatus 决定 */
    private final AtomicInteger failFirst = new AtomicInteger();
    private volatile int failStatus = 503;
    private volatile String response = "{}";

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            hits.incrementAndGet();
            lastBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            lastAuth.set(String.valueOf(exchange.getRequestHeaders().getFirst("authorization")));
            int remaining = failFirst.getAndUpdate(n -> Math.max(0, n - 1));
            int status = remaining > 0 ? failStatus : 200;
            byte[] body = (status == 200 ? response : "{\"error\":{\"message\":\"busy\"}}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("content-type", "application/json");
            exchange.sendResponseHeaders(status, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/v1";
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private MimoSpeechModel model(int maxRetries) {
        return new MimoSpeechModel(baseUrl, "test-key", "mimo-v2.5-tts", "冰糖", "用中文，语气亲切自然。",
                "mimo-v2.5-asr", "zh", 5_000, maxRetries, 10, MAPPER);
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

    @Test
    void 识别拿到空文本时报错() {
        response = "{\"choices\":[{\"message\":{\"content\":\"\"}}]}";
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

    @Test
    void 重试次数用尽后抛出最后一次原因() {
        failFirst.set(10);
        SpeechException error = assertThrows(SpeechException.class, () -> model(1).synthesize("你好"));
        assertEquals(503, error.status());
        assertEquals(2, hits.get(), "maxRetries=1 → 共两次尝试");
    }
}
