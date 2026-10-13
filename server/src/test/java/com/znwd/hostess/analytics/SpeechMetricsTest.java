package com.znwd.hostess.analytics;

import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 声学遥测的累加与出报表口径。
 *
 * <p>这一层守两件事：
 * <ol>
 *   <li><b>坏数据不许进计数器</b>：接口无鉴权，而内存计数没有回退路径——一条负数或 NaN 进去，
 *       重启前运营面板读到的都是错的（表现得像「展厅底噪是负的」这种没法解释的现象）；</li>
 *   <li><b>均值口径只留一份</b>：前端只报和与次数，均值在服务端算，面板不再自己除，
 *       否则两个入口读到的「平均底噪」可能不一样。</li>
 * </ol>
 */
class SpeechMetricsTest {

    private static Analytics analytics() {
        // 库相关依赖传 null：这条路径不落库，也不需要 DatabaseStatus（构造器显式接受 null）
        return new Analytics(null, null, null, null, 50);
    }

    private static Map<String, Double> deltas(Object... pairs) {
        Map<String, Double> out = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            out.put((String) pairs[i], (Double) pairs[i + 1]);
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> speechStats(Analytics analytics) {
        return (Map<String, Object>) analytics.stats(0).get("speech");
    }

    /** 上报过就该出 speech 段：面板据此决定显不显示整块声学行 */
    private static Map<String, Object> reportedSpeechStats(Analytics analytics) {
        assertTrue(analytics.stats(0).containsKey("speech"), "上报过就该出 speech 段");
        return speechStats(analytics);
    }

    /** 取一个数出来断言：字段类型是 Object，直接写 assertEquals(double, Object) 会和重载打架 */
    private static double num(Map<String, Object> stats, String key) {
        return ((Number) stats.get(key)).doubleValue();
    }

    @Test
    void 没有上报过就不出声学段() {
        // 面板据此决定显不显示整块声学行：没开常开聆听的部署不该一直挂着一排 0（看着像功能没生效）
        assertFalse(analytics().stats(0).containsKey("speech"));
    }

    @Test
    void 多批增量按累加合并() {
        Analytics analytics = analytics();
        analytics.recordSpeech(deltas("utterances", 2.0, "autoEnds", 1.0));
        analytics.recordSpeech(deltas("utterances", 3.0, "manualEnds", 1.0));

        Map<String, Object> speech = reportedSpeechStats(analytics);
        assertEquals(5.0, num(speech, "utterances"));
        assertEquals(1.0, num(speech, "autoEnds"));
        assertEquals(1.0, num(speech, "manualEnds"));
    }

    @Test
    void 坏数据被丢掉而不是污染计数器() {
        Analytics analytics = analytics();
        analytics.recordSpeech(deltas("utterances", 2.0));
        Map<String, Double> bad = new LinkedHashMap<>();
        bad.put("utterances", -5.0);
        bad.put("autoEnds", Double.NaN);
        bad.put("manualEnds", Double.POSITIVE_INFINITY);
        bad.put("noiseSamples", 1e9);   // 超过单项上限
        bad.put("segmentCalls", null);
        analytics.recordSpeech(bad);
        analytics.recordSpeech(null);
        analytics.recordSpeech(Map.of());

        Map<String, Object> speech = reportedSpeechStats(analytics);
        assertEquals(2.0, num(speech, "utterances"), "负数不该被累加进去");
        assertFalse(speech.containsKey("autoEnds"), "NaN 不该进计数器");
        assertFalse(speech.containsKey("manualEnds"), "Infinity 不该进计数器");
        assertEquals(1e6, num(speech, "noiseSamples"), "超大值按上限收敛，而不是原样累加");
    }

    @Test
    void 均值在服务端算且无样本时有写死的口径() {
        Analytics analytics = analytics();
        analytics.recordSpeech(deltas("utterances", 1.0));   // 只为让 speech 段出现
        Map<String, Object> empty = reportedSpeechStats(analytics);
        assertEquals(0.0, num(empty, "avgNoiseRms"), "还没采到底噪时是 0");
        assertEquals(-120.0, num(empty, "avgNoiseDb"), "没有样本的底噪写成 -120dB，一眼能看出是空的");
        assertEquals(0.0, num(empty, "avgPartialLatencyMs"));

        analytics.recordSpeech(deltas(
                "noiseSamples", 4.0, "noiseFloorSum", 0.4,                  // 均值 0.1 → 20*log10(0.1) = -20dB
                "partialLatencyCount", 2.0, "partialLatencySumMs", 3000.0,  // 均值 1500ms
                "segmentCalls", 2.0));

        Map<String, Object> speech = reportedSpeechStats(analytics);
        assertEquals(0.1, num(speech, "avgNoiseRms"), 1e-9);
        assertEquals(-20.0, num(speech, "avgNoiseDb"), 1e-9);
        assertEquals(1500.0, num(speech, "avgPartialLatencyMs"), 1e-9);
        // 原始和也照原样出：现场调阈值时要能看到构成，而不是只有一个均值
        assertEquals(0.4, num(speech, "noiseFloorSum"), 1e-9);
        assertEquals(3000.0, num(speech, "partialLatencySumMs"), 1e-9);
    }

    @Test
    void 三段延迟与成本口径在服务端算() {
        // §4 P2 修订 1：原文一个「说完→首音 ≤1.5s」把三段糊在一起，超标了不知道该优化谁。
        // 拆开之后每一段都要能在面板上单独读到，所以这里逐段钉住口径。
        Analytics analytics = analytics();
        analytics.recordSpeech(deltas(
                "finalCalls", 2.0,
                "finalEndDelaySumMs", 2000.0,   // 均值 1000ms：说完 → VAD 判出收尾
                "finalLatencySumMs", 3600.0,    // 均值 1800ms：说完 → 终稿文本
                "finalServerSumMs", 1100.0,     // 均值 550ms：服务端自己量的那一段
                "finalAudioMs", 5000.0,
                "firstSentenceCount", 2.0, "firstSentenceSumMs", 1400.0,  // 均值 700ms
                "firstAudioCount", 2.0, "firstAudioSumMs", 800.0,         // 均值 400ms
                "segmentAudioMs", 8000.0));

        Map<String, Object> speech = reportedSpeechStats(analytics);
        assertEquals(1000.0, num(speech, "avgFinalEndDelayMs"), 1e-9);
        assertEquals(1800.0, num(speech, "avgFinalLatencyMs"), 1e-9);
        assertEquals(550.0, num(speech, "avgFinalServerMs"), 1e-9);
        assertEquals(700.0, num(speech, "avgFirstSentenceMs"), 1e-9);
        assertEquals(400.0, num(speech, "avgFirstAudioMs"), 1e-9);
        // 成本口径（§5 S8）：分段 8s + 终稿 5s——ASR 按音频秒计费，只报次数算不出账
        assertEquals(13.0, num(speech, "asrAudioSec"), 1e-9);
    }

    @Test
    void 自适应阈值与回声比例() {
        // 阈值与底噪必须并排可读（§5 S1），回声的两道比例则是插话门限（P3a-2）的依据
        Analytics analytics = analytics();
        analytics.recordSpeech(deltas(
                "thresholdSamples", 4.0, "thresholdSum", 0.12,   // 均值 0.03
                "echoSamples", 10.0, "echoFloorSum", 0.3,        // 均值 0.03 → -30.5dB
                "echoOverCount", 2.0, "echoFarOverCount", 1.0));

        Map<String, Object> speech = reportedSpeechStats(analytics);
        assertEquals(0.03, num(speech, "avgSpeechThreshold"), 1e-9);
        assertEquals(0.03, num(speech, "avgEchoRms"), 1e-9);
        assertEquals(-30.5, num(speech, "avgEchoDb"), 1e-9);
        assertEquals(0.2, num(speech, "echoOverRate"), 1e-9);
        assertEquals(0.1, num(speech, "echoFarOverRate"), 1e-9);
    }

    @Test
    void 库中途恢复不会把现场样本抹掉() {
        // restore() 在「库中途恢复」时也会被调到：声学数据不落库，在那里清零等于把本次运行的样本删了
        Analytics analytics = analytics();
        analytics.recordSpeech(deltas("utterances", 7.0));
        analytics.restore();

        assertEquals(7.0, num(reportedSpeechStats(analytics), "utterances"));
    }
}
