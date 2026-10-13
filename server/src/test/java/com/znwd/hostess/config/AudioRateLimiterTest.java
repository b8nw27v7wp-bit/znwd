package com.znwd.hostess.config;

import org.junit.jupiter.api.Test;

import com.znwd.hostess.http.RateLimiter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * 语音相关的三个限流桶必须是**三份互不占用的状态**，且配额各自可配。
 *
 * <p>这是常开聆听带来的改动：滚动分段识别会让一次讲话连打多次 {@code /api/speech/recognize}，
 * 与提问共用一个桶（改动前的行为）会在几秒内把 30/min 打满，把访客真正的提问饿死。
 * 三个桶的拆分在 {@code AppConfig} 里是三个 {@code @Bean}，这里把它钉成行为：
 * 打满任意一个，另外两个照常放行。
 */
class AudioRateLimiterTest {

    /** 配额取 application.yml 的默认值：这组数字本身就是要守住的口径（识别 120 对提问 30） */
    private static AppProperties props() {
        AppProperties props = org.mockito.Mockito.mock(AppProperties.class);
        org.mockito.Mockito.when(props.chatRatePerMin()).thenReturn(30);
        org.mockito.Mockito.when(props.feedbackRatePerMin()).thenReturn(10);
        org.mockito.Mockito.when(props.audioSynthRatePerMin()).thenReturn(60);
        org.mockito.Mockito.when(props.audioAsrRatePerMin()).thenReturn(120);
        org.mockito.Mockito.when(props.audioMetricsRatePerMin()).thenReturn(30);
        return props;
    }

    @Test
    void 五个桶是五份独立状态() {
        AppConfig config = new AppConfig();
        AppProperties props = props();
        RateLimiter chat = config.chatRateLimiter(props);
        RateLimiter feedback = config.feedbackRateLimiter(props);
        RateLimiter synth = config.speechSynthRateLimiter(props);
        RateLimiter asr = config.asrRateLimiter(props);
        RateLimiter metrics = config.speechMetricsRateLimiter(props);

        RateLimiter[] all = {chat, feedback, synth, asr, metrics};
        for (int i = 0; i < all.length; i++) {
            for (int j = i + 1; j < all.length; j++) {
                assertNotSame(all[i], all[j], "限流桶必须是各自独立的实例");
            }
        }
    }

    @Test
    void 打满提问桶不影响识别桶() {
        AppConfig config = new AppConfig();
        AppProperties props = props();
        RateLimiter chat = config.chatRateLimiter(props);
        RateLimiter asr = config.asrRateLimiter(props);

        // 提问桶打满（30 次/分）
        for (int i = 0; i < 30; i++) {
            assertNull(chat.allow("10.0.0.1"), "第 " + (i + 1) + " 次应当放行");
        }
        assertNotNull(chat.allow("10.0.0.1"), "第 31 次该被限");

        // 同一个 IP 的识别不受影响：这正是拆桶要保住的那条路径
        for (int i = 0; i < 120; i++) {
            assertNull(asr.allow("10.0.0.1"), "识别第 " + (i + 1) + " 次不该被提问桶拖累");
        }
        assertNotNull(asr.allow("10.0.0.1"), "识别自己的配额打满后仍要限住");
    }

    @Test
    void 识别配额比提问宽得多() {
        AppConfig config = new AppConfig();
        AppProperties props = props();
        RateLimiter chat = config.chatRateLimiter(props);
        RateLimiter asr = config.asrRateLimiter(props);

        int chatAllowed = 0;
        while (chat.allow("10.0.0.2") == null && chatAllowed < 1000) {
            chatAllowed++;
        }
        int asrAllowed = 0;
        while (asr.allow("10.0.0.2") == null && asrAllowed < 1000) {
            asrAllowed++;
        }
        assertEquals(30, chatAllowed);
        assertEquals(120, asrAllowed);
    }

    @Test
    void 配额可由环境变量压到很小() {
        // 现场验收要用 AUDIO_ASR_RATE_PER_MIN=2 跑「分段静默失败、终稿 429」这条路径
        AppProperties props = org.mockito.Mockito.mock(AppProperties.class);
        org.mockito.Mockito.when(props.audioAsrRatePerMin()).thenReturn(2);
        RateLimiter asr = new AppConfig().asrRateLimiter(props);

        assertNull(asr.allow("10.0.0.3"));
        assertNull(asr.allow("10.0.0.3"));
        assertNotNull(asr.allow("10.0.0.3"));
    }
}
