package com.znwd.hostess.web;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import com.znwd.hostess.analytics.Analytics;
import com.znwd.hostess.audio.SpeechException;
import com.znwd.hostess.audio.SpeechModel;
import com.znwd.hostess.config.AppProperties;
import com.znwd.hostess.http.LruCache;
import com.znwd.hostess.http.RateLimiter;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import org.mockito.Mockito;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 语音接口的 HTTP 契约用例：声学遥测端点（纯增量）与「识别配额与提问配额分立」这条改动。
 *
 * <p>配置用 Mockito 代身而不是绑 application.yml：本类要同时验「语音未启用时遥测照样能用」
 * 与「语音启用时识别走的是识别桶」，两个前提互斥，只有逐用例控制 {@code audioEnabled()} 才测得全。
 */
@WebMvcTest(controllers = SpeechController.class)
class SpeechWebContractTest {

    @Autowired
    MockMvc mvc;

    @MockitoBean
    SpeechModel speech;

    @MockitoBean
    Analytics analytics;

    @Autowired
    AppProperties props;

    @MockitoBean(name = "asrRateLimiter")
    RateLimiter asrRateLimiter;

    @MockitoBean(name = "speechMetricsRateLimiter")
    RateLimiter metricsRateLimiter;

    @MockitoBean(name = "speechSynthRateLimiter")
    RateLimiter synthRateLimiter;

    @MockitoBean(name = "speechSynthCache")
    LruCache<byte[]> synthCache;

    /**
     * 配置用代身而不是绑 application.yml：本类要同时验「语音未启用时遥测照样能用」与
     * 「语音启用时识别走的是识别桶」，两个前提互斥，只有逐用例控制 {@code audioEnabled()} 才测得全。
     *
     * <p>桩必须在**建 bean 时**就打好（不能等到 {@code @BeforeEach}）：{@code StaticUiConfig} 在
     * 上下文装配期就会拿 {@code webDistDirPath()} 去 resolve，Mockito 默认给的 null 会让整个上下文起不来。
     */
    @TestConfiguration
    static class StubProps {
        @Bean
        AppProperties appProperties() {
            AppProperties props = Mockito.mock(AppProperties.class);
            when(props.webDistDirPath()).thenReturn(Path.of("target/no-web-dist"));
            when(props.corsOriginList()).thenReturn(List.of());
            when(props.adminTokenOrNull()).thenReturn(null);
            when(props.adminTokenRequired()).thenReturn(false);
            when(props.audioEnabled()).thenReturn(false);
            when(props.audioMaxUploadBytes()).thenReturn(2L * 1024 * 1024);
            when(props.audioMaxChars()).thenReturn(300);
            when(props.trustForwardedFor()).thenReturn(false);
            return props;
        }
    }

    /**
     * 三个桶默认放行 + 未启用语音。
     *
     * <p>限流桶必须显式打桩：Mockito 对返回 {@code Long} 的方法默认给 0（不是 null），
     * 而 0 在 {@link RateLimiter#allow} 里是「要等到这一刻才能再来」——不桩就是 429。
     * 配置代身在这里被重新打桩（上个用例可能把 {@code audioEnabled} 改成了 true）。
     */
    @BeforeEach
    void defaults() {
        when(asrRateLimiter.allow(any())).thenReturn(null);
        when(metricsRateLimiter.allow(any())).thenReturn(null);
        when(synthRateLimiter.allow(any())).thenReturn(null);
        when(props.audioEnabled()).thenReturn(false);
    }

    @Test
    void 遥测上报累加进运营统计且不需要语音启用() throws Exception {
        // 没有 requireEnabled：AUDIO_PROVIDER=none 时前端根本开不了麦，「为什么开不了麦」
        // 恰恰是运营最需要从这组数据里看到的结论——跟着一起关掉等于把唯一的证据也删了
        mvc.perform(post("/api/speech/metrics").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"utterances\":3,\"autoEnds\":2,\"noiseFloorSum\":0.12,\"noiseSamples\":4}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Double>> captor = ArgumentCaptor.forClass(Map.class);
        verify(analytics).recordSpeech(captor.capture());
        assertThat(captor.getValue())
                .containsEntry("utterances", 3.0)
                .containsEntry("noiseFloorSum", 0.12);
    }

    @Test
    void 遥测含未知字段回400且不落统计() throws Exception {
        mvc.perform(post("/api/speech/metrics").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"utterence\":1}"))
                .andExpect(status().isBadRequest())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.error").value("validation_error"))
                .andExpect(jsonPath("$.message").isNotEmpty());

        verify(analytics, never()).recordSpeech(any());
    }

    @Test
    void 遥测的非法数值回400() throws Exception {
        for (String body : new String[] {
                "{\"utterances\":-1}",
                "{\"utterances\":\"3\"}",
                "{\"utterances\":true}",
                "{\"utterances\":99999999}",
        }) {
            mvc.perform(post("/api/speech/metrics").contentType(MediaType.APPLICATION_JSON).content(body))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error").value("validation_error"));
        }
        verify(analytics, never()).recordSpeech(any());
    }

    @Test
    void 遥测请求体不是JSON对象回400() throws Exception {
        mvc.perform(post("/api/speech/metrics").contentType(MediaType.APPLICATION_JSON).content("[1,2]"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("validation_error"));
    }

    @Test
    void 遥测被打满时回429统一信封() throws Exception {
        when(metricsRateLimiter.allow(any())).thenReturn(9L);

        mvc.perform(post("/api/speech/metrics").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"utterances\":1}"))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error").value("rate_limited"))
                .andExpect(jsonPath("$.retryAfterSec").value(9));
    }

    @Test
    void 遥测的入参校验先于限流() throws Exception {
        // 形状不对就是 400，与「本机配额用尽」无关：反过来的话现场排查会被 429 指错方向
        when(metricsRateLimiter.allow(any())).thenReturn(9L);

        mvc.perform(post("/api/speech/metrics").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"nope\":1}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("validation_error"));
    }

    /**
     * 46 字节的最小合法 WAV（44 字节头 + 2 字节采样）。
     *
     * <p>识别在限流之前先做入参校验，拿假载荷去测配额只会拿到 400——那验的是解析器，不是限流。
     */
    private static String minimalWavDataUrl() {
        ByteBuffer buf = ByteBuffer.allocate(46).order(ByteOrder.LITTLE_ENDIAN);
        buf.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(38);
        buf.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(16);
        buf.putShort((short) 1);       // PCM
        buf.putShort((short) 1);       // 单声道
        buf.putInt(16_000);
        buf.putInt(32_000);
        buf.putShort((short) 2);
        buf.putShort((short) 16);      // 位深
        buf.put("data".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(2);
        buf.putShort((short) 0);
        return "data:audio/wav;base64," + Base64.getEncoder().encodeToString(buf.array());
    }

    @Test
    void 识别用识别桶的配额() throws Exception {
        // 拆桶的回归点：换回 chatRateLimiter 时 30/min 会被分段识别瞬间打满，
        // 这一条会红（本类里提问桶根本没有打进这个 controller，是装配层面的约束）
        when(props.audioEnabled()).thenReturn(true);
        when(asrRateLimiter.allow(any())).thenReturn(12L);

        mvc.perform(post("/api/speech/recognize").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"audio\":\"" + minimalWavDataUrl() + "\"}"))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error").value("rate_limited"))
                .andExpect(jsonPath("$.retryAfterSec").value(12));
    }

    @Test
    void 识别放行后走到语音模型() throws Exception {
        when(props.audioEnabled()).thenReturn(true);
        when(speech.recognize(any())).thenThrow(new SpeechException(500, "上游挂了", true));

        // 放行后是 502（上游失败），而不是 429/503——证明限流这道过了、且没有别的闸门挡在前面
        mvc.perform(post("/api/speech/recognize").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"audio\":\"" + minimalWavDataUrl() + "\"}"))
                .andExpect(status().isBadGateway())
                .andExpect(jsonPath("$.error").value("speech_failed"));
    }

    @Test
    void 未启用语音时识别回503而不是拿遥测的配额顶包() throws Exception {
        mvc.perform(post("/api/speech/recognize").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"audio\":\"" + minimalWavDataUrl() + "\"}"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.error").value("speech_unavailable"));
    }
}
