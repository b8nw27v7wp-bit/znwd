package com.znwd.hostess.web;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.Base64;
import java.util.Map;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.znwd.hostess.audio.SpeechParser;
import com.znwd.hostess.config.AppProperties;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 请求体大小上限：超限写请求必须在进业务之前被拒，且不得因为「没有 Content-Length」而绕过。 */
class RequestSizeLimitFilterTest {

    private final RequestSizeLimitFilter filter = new RequestSizeLimitFilter(new ObjectMapper(), props(Map.of()));

    /**
     * 只塞进需要的键就够（空源绑定会报「No value bound」）：没给的键走 AppProperties 的缺省访问器。
     *
     * @param overrides 形如 `znwd.audio.max-upload-bytes` → `"4194304"`
     */
    private static AppProperties props(Map<String, Object> overrides) {
        Map<String, Object> values = new java.util.LinkedHashMap<>();
        values.put("znwd.node-env", "production");
        values.putAll(overrides);
        return new Binder(new MapConfigurationPropertySource(values))
                .bind("znwd", AppProperties.class).get();
    }

    private static RequestSizeLimitFilter filterWith(long maxUploadBytes) {
        return new RequestSizeLimitFilter(new ObjectMapper(),
                props(Map.of("znwd.audio.max-upload-bytes", String.valueOf(maxUploadBytes))));
    }

    @Test
    void 超过上限的请求体被拒且不进业务链路() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/chat");
        request.setContent(new byte[(int) RequestSizeLimitFilter.MAX_BODY_BYTES + 1]);
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, response, chain);

        assertEquals(413, response.getStatus());
        String body = response.getContentAsString();
        assertTrue(body.contains("payload_too_large"), "必须是统一错误信封：" + body);
        assertTrue(body.contains("requestId"), "错误信封要带 requestId：" + body);
        assertNull(chain.getRequest(), "被拒的请求不得进入后续链路");
    }

    @Test
    void 恰好等于上限的请求放行() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/chat");
        request.setContent(new byte[(int) RequestSizeLimitFilter.MAX_BODY_BYTES]);
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, response, chain);

        assertEquals(200, response.getStatus());
        assertNotNull(chain.getRequest(), "边界内的请求应当继续处理");
    }

    @Test
    void 无ContentLength的写请求按超限处理() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/chat");
        // 不设 content：MockHttpServletRequest 的 getContentLength() 返回 -1，
        // 即分块传输那种「无法判定大小」的情形
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(request, response, new MockFilterChain());

        assertEquals(413, response.getStatus(), "无法判定大小就不能放行，否则是个绕过口子");
    }

    @Test
    void 无请求体的读方法与预检请求不受影响() throws Exception {
        for (String method : new String[] {"GET", "OPTIONS", "DELETE"}) {
            MockHttpServletRequest request = new MockHttpServletRequest(method, "/api/health");
            request.setContent(new byte[(int) RequestSizeLimitFilter.MAX_BODY_BYTES * 100]);
            MockHttpServletResponse response = new MockHttpServletResponse();
            MockFilterChain chain = new MockFilterChain();

            filter.doFilter(request, response, chain);

            assertEquals(200, response.getStatus(), method + " 不带业务请求体，不该被拦");
            assertNotNull(chain.getRequest());
        }
    }

    @Test
    void 语音接口放到录音上限否则两秒都录不了() throws Exception {
        // 16kHz WAV 约 32KB/s，base64 再膨胀 4/3：按 64KB 卡的话半秒就超
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/speech/recognize");
        request.setContent(new byte[(int) RequestSizeLimitFilter.MAX_BODY_BYTES + 32 * 1024]);
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, response, chain);

        assertEquals(200, response.getStatus(), "语音路径应当放行");
        assertNotNull(chain.getRequest(), "放行的请求要继续进业务链路");
    }

    @Test
    void 语音接口自己也有硬上限() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/speech/recognize");
        request.setContent(new byte[(int) RequestSizeLimitFilter.DEFAULT_AUDIO_BODY_BYTES + 1]);
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, response, chain);

        assertEquals(413, response.getStatus(), "放宽不等于不设限");
        assertTrue(response.getContentAsString().contains("payload_too_large"));
        assertNull(chain.getRequest());
    }

    /** 缺省配置下的边界：正好等于缺省上限放行、多一个字节就拒——两个方向一起钉住「缺省值就是它」 */
    @Test
    void 缺省上限正好等于推出来的那个数() throws Exception {
        for (long size : new long[] {
                RequestSizeLimitFilter.DEFAULT_AUDIO_BODY_BYTES,
                RequestSizeLimitFilter.DEFAULT_AUDIO_BODY_BYTES + 1}) {
            MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/speech/recognize");
            request.setContent(new byte[(int) size]);
            MockHttpServletResponse response = new MockHttpServletResponse();

            filter.doFilter(request, response, new MockFilterChain());

            assertEquals(size == RequestSizeLimitFilter.DEFAULT_AUDIO_BODY_BYTES ? 200 : 413, response.getStatus(),
                    "body=" + size);
        }
    }

    /**
     * **`AUDIO_MAX_UPLOAD_BYTES` 调大必须真的管用**：它推出来的请求体上限跟着走。
     *
     * <p>这就是 V4 那个坑的回归：早先两个数各写各的 2MB，把上传上限调到 4MB（想支持更长的录音）时，
     * 请求体在 **base64 膨胀之后** 是 5.3MB，会先被这里的 2MB 硬闸门 413 掉——运维对着
     * 「上限 2048KB」查半天，而文档还写着「识别上传上限（解码后的 WAV 字节）」。
     */
    @Test
    void 上传上限调大时请求体闸门跟着放宽() throws Exception {
        long fourMb = 4 * 1024 * 1024;
        // 4MB 解码后的 WAV 编码成 body ≈ 5.3MB，再加 JSON 壳
        long body = fourMb / 3 * 4 + 512;
        RequestSizeLimitFilter wide = filterWith(fourMb);

        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/speech/recognize");
        request.setContent(new byte[(int) body]);
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        wide.doFilter(request, response, chain);

        assertEquals(200, response.getStatus(), "调大了上传上限，闸门必须跟着走，否则那个配置形同虚设");
        assertNotNull(chain.getRequest());
        assertEquals(413, runFilter(filter, body), "缺省配置下同样大小的请求体仍然要被拒（旧的 2MB 口径）");
    }

    /** 反向：上传上限调小时闸门也收紧（下限是常规请求的 64KB，不会收到比它更严） */
    @Test
    void 上传上限调小时请求体闸门跟着收紧() throws Exception {
        RequestSizeLimitFilter narrow = filterWith(64 * 1024);
        assertEquals(413, runFilter(narrow, 200 * 1024), "64KB 上传上限 → 200KB 的请求体不该放行");
        assertEquals(200, runFilter(narrow, 64 * 1024), "闸门不低于普通请求的 64KB");
    }

    /**
     * 两层口径的护栏：外层请求体闸门至少要与内层解析器的上限一样宽。
     *
     * <p>否则「解码后正好等于 `AUDIO_MAX_UPLOAD_BYTES` 的合法录音」会在过滤器那一层被 413 拦掉，
     * 拿不到 {@code SpeechParser} 那条带细节的 4xx（它会说清是 WAV 太大还是字段不对）。两处各推导
     * 一次（过滤器 `maxUpload/3*4+1KB` 对整段 body；解析器 `maxUpload/3*4+8` 对 base64 子串），
     * 这条把它们钉在一起：同一组配置下，解析器能收下的最大请求体，过滤器也必须放行。
     */
    @Test
    void 过滤器闸门不比解析器上限更严() throws Exception {
        long maxUpload = 2 * 1024 * 1024;
        ObjectMapper mapper = new ObjectMapper();
        RequestSizeLimitFilter gate = filterWith(maxUpload);

        Map<String, String> body = Map.of("audio",
                "data:audio/wav;base64," + Base64.getEncoder().encodeToString(wavOfSize((int) maxUpload)));
        byte[] serialized = mapper.writeValueAsBytes(body);

        assertTrue(SpeechParser.audio(body, maxUpload).ok(),
                "解析器要收下这个「解码后正好等于上传上限」的录音");
        assertTrue(serialized.length <= gate.audioBodyLimit(),
                "过滤器闸门 " + gate.audioBodyLimit() + " 放不下解析器接受的最大请求体 " + serialized.length);
    }

    /** 造一段合法 WAV：44 字节头 + 填充到指定总长（riffSize / dataSize 自洽，过 isWav） */
    private static byte[] wavOfSize(int size) {
        byte[] wav = new byte[size];
        putAscii(wav, 0, "RIFF");
        putLe32(wav, 4, size - 8);
        putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt ");
        putLe32(wav, 16, 16);        // fmt chunk 长度
        putAscii(wav, 36, "data");
        putLe32(wav, 40, size - 44); // data chunk 长度
        return wav;
    }

    private static void putAscii(byte[] target, int offset, String text) {
        for (int i = 0; i < text.length(); i++) {
            target[offset + i] = (byte) text.charAt(i);
        }
    }

    private static void putLe32(byte[] target, int offset, int value) {
        target[offset] = (byte) value;
        target[offset + 1] = (byte) (value >>> 8);
        target[offset + 2] = (byte) (value >>> 16);
        target[offset + 3] = (byte) (value >>> 24);
    }

    /** 跑一遍过滤器、返回状态码 */
    private static int runFilter(RequestSizeLimitFilter target, long size) throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/speech/recognize");
        request.setContent(new byte[(int) size]);
        MockHttpServletResponse response = new MockHttpServletResponse();
        target.doFilter(request, response, new MockFilterChain());
        return response.getStatus();
    }

    @Test
    void 语音路径的前缀匹配不会误伤同名开头的其它路径() throws Exception {
        // /api/speechy 不是语音接口：前缀匹配必须带斜杠，否则是个绕过 64KB 的口子
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/speechy");
        request.setContent(new byte[(int) RequestSizeLimitFilter.MAX_BODY_BYTES + 1]);
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(request, response, new MockFilterChain());

        assertEquals(413, response.getStatus());
    }
}
