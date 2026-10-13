package com.znwd.hostess.audio;

import java.util.Base64;
import java.util.Map;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 语音入参解析：错误必须落在可判定的原因码上（路由层据此回 400），不能漏成 500 或空指针。 */
class SpeechParserTest {

    private static final int MAX_CHARS = 300;
    private static final long MAX_BYTES = 2 * 1024 * 1024;

    /** 44 字节头 + 指定字节数的数据：够过 RIFF/WAVE 校验 */
    private static byte[] minimalWav() {
        return minimalWav(2);
    }

    /** 数据字节数为 0 时就是「只有头的空录音」 */
    private static byte[] minimalWav(int dataBytes) {
        byte[] wav = new byte[44 + dataBytes];
        System.arraycopy("RIFF".getBytes(), 0, wav, 0, 4);
        System.arraycopy("WAVE".getBytes(), 0, wav, 8, 4);
        System.arraycopy("fmt ".getBytes(), 0, wav, 12, 4);
        System.arraycopy("data".getBytes(), 0, wav, 36, 4);
        return wav;
    }

    private static String dataUrl(byte[] wav) {
        return "data:audio/wav;base64," + Base64.getEncoder().encodeToString(wav);
    }

    // ── 合成入参 ──────────────────────────────────────────────────────────

    @Test
    void 文本正常时去掉首尾空白并放行() {
        SpeechParser.Result<String> result = SpeechParser.text(Map.of("text", "  你好  "), MAX_CHARS);
        assertTrue(result.ok());
        assertEquals("你好", result.value());
    }

    @Test
    void 文本缺失或只有空白都算缺参() {
        for (Object body : new Object[] {Map.of(), Map.of("text", "   "), Map.of("text", 42), "not-a-map"}) {
            SpeechParser.Result<String> result = SpeechParser.text(body, MAX_CHARS);
            assertFalse(result.ok(), "应判为不合法：" + body);
            assertNull(result.value());
        }
    }

    @Test
    void 文本超长直接拒绝而不是截断念半句() {
        SpeechParser.Result<String> result = SpeechParser.text(Map.of("text", "字".repeat(MAX_CHARS + 1)), MAX_CHARS);
        assertFalse(result.ok());
        assertEquals(SpeechParser.Reason.TEXT_TOO_LONG, result.reason());
        assertTrue(SpeechParser.message(result.reason(), MAX_BYTES, MAX_CHARS).contains("300"));
    }

    // ── 识别入参 ──────────────────────────────────────────────────────────

    @Test
    void dataURL与裸base64都能解出同一段WAV() {
        byte[] wav = minimalWav();
        SpeechParser.Result<byte[]> fromUrl = SpeechParser.audio(Map.of("audio", dataUrl(wav)), MAX_BYTES);
        SpeechParser.Result<byte[]> fromRaw = SpeechParser.audio(
                Map.of("audio", Base64.getEncoder().encodeToString(wav)), MAX_BYTES);

        assertTrue(fromUrl.ok());
        assertTrue(fromRaw.ok());
        assertEquals(wav.length, fromUrl.value().length);
        assertEquals(wav.length, fromRaw.value().length);
    }

    @Test
    void 声明成mp3的dataURL被拒() {
        // 前端只产 WAV；收下 mp3 只会让「浏览器录到的格式与接口要的格式不一致」晚到运行时才暴露
        SpeechParser.Result<byte[]> result = SpeechParser.audio(
                Map.of("audio", "data:audio/mpeg;base64," + Base64.getEncoder().encodeToString(minimalWav())),
                MAX_BYTES);
        assertFalse(result.ok());
        assertEquals(SpeechParser.Reason.AUDIO_UNSUPPORTED_FORMAT, result.reason());
    }

    @Test
    void 不是WAV的数据被拒() {
        String notWav = "data:audio/wav;base64," + Base64.getEncoder().encodeToString("hello world, definitely not audio".getBytes());
        SpeechParser.Result<byte[]> result = SpeechParser.audio(Map.of("audio", notWav), MAX_BYTES);
        assertFalse(result.ok());
        assertEquals(SpeechParser.Reason.AUDIO_UNSUPPORTED_FORMAT, result.reason());
    }

    @Test
    void 非法base64被拒且不抛异常() {
        SpeechParser.Result<byte[]> result = SpeechParser.audio(Map.of("audio", "data:audio/wav;base64,!!!not-base64!!!"),
                MAX_BYTES);
        assertFalse(result.ok());
        assertNotNull(result.reason());
    }

    @Test
    void 音频缺失时给出可判定的原因() {
        for (Object body : new Object[] {Map.of(), Map.of("audio", "  "), Map.of("audio", 12), "nope"}) {
            SpeechParser.Result<byte[]> result = SpeechParser.audio(body, MAX_BYTES);
            assertFalse(result.ok(), "应判为不合法：" + body);
        }
    }

    @Test
    void 只有WAV头没有采样的空录音被本地拒() {
        // 边界探测 W08：44 字节的 WAV（只有头、0 个采样）放过去的话，上游回 500，客户端要等完
        // 重试（默认 1s+2s）才拿到 502——本地一步拒掉更准确也更快
        SpeechParser.Result<byte[]> result = SpeechParser.audio(Map.of("audio", dataUrl(minimalWav(0))), MAX_BYTES);
        assertFalse(result.ok());
        assertEquals(SpeechParser.Reason.AUDIO_EMPTY, result.reason());
        assertTrue(SpeechParser.message(result.reason(), MAX_BYTES, MAX_CHARS).contains("音频数据"));
    }

    @Test
    void 超出上限的音频按体积拒绝() {
        // 上限 40 字节 < 最小 WAV 的 46 字节；同时校验的是「按 base64 长度先卡一道」那条早退
        SpeechParser.Result<byte[]> result = SpeechParser.audio(Map.of("audio", dataUrl(minimalWav())), 40);
        assertFalse(result.ok());
        assertEquals(SpeechParser.Reason.AUDIO_TOO_LARGE, result.reason());
        assertTrue(SpeechParser.message(result.reason(), 40, MAX_CHARS).contains("KB"));
    }

    @Test
    void 声学遥测只收白名单里的有限非负数值() {
        SpeechParser.Result<Map<String, Double>> ok = SpeechParser.metrics(
                Map.of("utterances", 3, "noiseFloorSum", 0.12, "noiseSamples", 4));
        assertTrue(ok.ok());
        assertEquals(3.0, ok.value().get("utterances").doubleValue());
        assertEquals(0.12, ok.value().get("noiseFloorSum").doubleValue());
    }

    @Test
    void 声学遥测的空对象合法() {
        // 前端攒不到东西就不该发，但发来了不是错——回空 map，由调用方决定要不要落库
        SpeechParser.Result<Map<String, Double>> result = SpeechParser.metrics(Map.of());
        assertTrue(result.ok());
        assertTrue(result.value().isEmpty());
    }

    @Test
    void 声学遥测拒未知字段而不是静默忽略() {
        // 静默忽略的表现是「面板上这一行永远是 0」，没有报错也没有日志——现场比对才发现
        for (Object body : new Object[] {
                Map.of("utterence", 1),          // 拼错一个字母
                Map.of("utterances", 1, "x", 2),
        }) {
            SpeechParser.Result<Map<String, Double>> result = SpeechParser.metrics(body);
            assertFalse(result.ok(), "应判为不合法：" + body);
            assertEquals(SpeechParser.Reason.METRICS_UNKNOWN_FIELD, result.reason());
        }
    }

    @Test
    void 声学遥测拒非数值负数与超大值() {
        for (Object value : new Object[] {
                "3", true, null, -1, -0.5,
                SpeechParser.METRIC_MAX_VALUE * 2,
                Double.POSITIVE_INFINITY, Double.NaN,
        }) {
            Map<String, Object> body = new java.util.HashMap<>();
            body.put("utterances", value);
            SpeechParser.Result<Map<String, Double>> result = SpeechParser.metrics(body);
            assertFalse(result.ok(), "应判为不合法：" + value);
            assertEquals(SpeechParser.Reason.METRICS_BAD_VALUE, result.reason());
        }
    }

    @Test
    void 声学遥测的请求体必须是JSON对象() {
        SpeechParser.Result<Map<String, Double>> result = SpeechParser.metrics("nope");
        assertFalse(result.ok());
        assertEquals(SpeechParser.Reason.BODY_NOT_OBJECT, result.reason());
    }

    @Test
    void 白名单里的键都有可读的错误文案() {
        for (String key : SpeechParser.METRIC_KEYS) {
            Map<String, Object> body = new java.util.HashMap<>();
            body.put(key, 0);
            assertTrue(SpeechParser.metrics(body).ok(), key + " 必须在白名单里");
        }
        assertTrue(SpeechParser.message(SpeechParser.Reason.METRICS_BAD_VALUE, MAX_BYTES, MAX_CHARS)
                .contains("有限"));
        assertTrue(SpeechParser.message(SpeechParser.Reason.METRICS_UNKNOWN_FIELD, MAX_BYTES, MAX_CHARS)
                .contains("未知字段"));
    }
}
