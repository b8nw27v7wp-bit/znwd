package com.znwd.hostess.web;

import java.util.LinkedHashMap;
import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import com.znwd.hostess.analytics.Analytics;
import com.znwd.hostess.audio.DisabledSpeechModel;
import com.znwd.hostess.audio.SpeechException;
import com.znwd.hostess.audio.SpeechModel;
import com.znwd.hostess.audio.SpeechParser;
import com.znwd.hostess.config.AppProperties;
import com.znwd.hostess.http.ClientIp;
import com.znwd.hostess.http.LruCache;
import com.znwd.hostess.http.RateLimiter;

/**
 * 语音接口：{@code /api/speech/synthesize}（文本→WAV 字节）与 {@code /api/speech/recognize}（WAV→文本）。
 *
 * <p>两条设计上的硬要求：
 * <ul>
 *   <li><b>key 只留在服务端</b>：前端拿不到也能播报，换音色/换模型只改服务端配置；</li>
 *   <li><b>未启用必须是可判定的 503</b>：前端据此退回浏览器内置播报，展板不会因为「没配语音」就哑掉。</li>
 * </ul>
 *
 * <p>合成按句调用（前端切片），因此这里有独立于问答的限流与一份结果缓存：展厅里同一句讲解词
 * 会被反复用到，命中缓存就把这次外部调用与首句延迟一起省掉。
 *
 * <p>第二条纯增量的路径是 {@code POST /api/speech/metrics}：底噪、VAD 判定、分段延迟这些量
 * 只在前端看得见，靠它汇进 {@code /api/stats}，运营才有得看（第 3 档的声学实测报告）。
 */
@RestController
public class SpeechController {

    private static final Logger log = LoggerFactory.getLogger(SpeechController.class);

    /**
     * 上游失败时给前端的固定文案。
     *
     * <p>不带上游响应体：那是内部拓扑与错误码细节，前端拿它也只是记进运营视图，
     * 而它的真正去处是服务端日志。
     */
    private static final String UPSTREAM_FAILED_MESSAGE = "语音服务暂时不可用（详见服务端日志）";

    private final SpeechModel speech;
    private final RateLimiter asrRateLimiter;
    private final RateLimiter metricsRateLimiter;
    private final RateLimiter synthRateLimiter;
    private final LruCache<byte[]> synthCache;
    private final Analytics analytics;
    private final AppProperties props;

    public SpeechController(SpeechModel speech,
                            @Qualifier("asrRateLimiter") RateLimiter asrRateLimiter,
                            @Qualifier("speechMetricsRateLimiter") RateLimiter metricsRateLimiter,
                            @Qualifier("speechSynthRateLimiter") RateLimiter synthRateLimiter,
                            @Qualifier("speechSynthCache") LruCache<byte[]> synthCache,
                            Analytics analytics,
                            AppProperties props) {
        this.speech = speech;
        this.asrRateLimiter = asrRateLimiter;
        this.metricsRateLimiter = metricsRateLimiter;
        this.synthRateLimiter = synthRateLimiter;
        this.synthCache = synthCache;
        this.analytics = analytics;
        this.props = props;
    }

    /**
     * 文本转语音：直接回 WAV 字节，前端拿到就能塞进 Audio 播。
     *
     * <p>刻意**不在 mapping 上声明 {@code produces = "audio/wav"}**：声明之后，参数错误时 Spring 会
     * 因为「异常响应是 JSON、而这个 handler 只产出 audio/wav」抛 {@code HttpMediaTypeNotAcceptableException}，
     * 落到兜底 handler 里变成 500 + 空响应体（边界探测 V13 实测：`Accept: audio/wav` + 缺 text）。媒体类型
     * 改由成功路径的 {@link ResponseEntity#contentType} 给出，异常路径就能正常回统一信封。
     */
    @PostMapping("/api/speech/synthesize")
    public ResponseEntity<byte[]> synthesize(@RequestBody(required = false) Object body,
                                             HttpServletRequest request) {
        SpeechParser.Result<String> parsed = SpeechParser.text(body, props.audioMaxChars());
        if (!parsed.ok()) {
            throw ApiException.validation(SpeechParser.message(parsed.reason(), props.audioMaxUploadBytes(),
                    props.audioMaxChars()));
        }
        // 先校验入参、再看服务开不开：请求本身形状不对就是 400，与本机是否启用语音无关。
        // 反过来的话，未启用语音的实例（例如 CI 的 AUDIO_PROVIDER=none）会把所有畸形请求
        // 一律回 503，tools/security.py 的 V01–V06 / W11–W18 / X26 就全变成「语音没开」
        // 的噪音，入参校验在 CI 里等于一次都没验过。
        requireEnabled();
        limit(synthRateLimiter, request);
        String text = parsed.value();
        String key = synthCacheKey(text);
        byte[] cached = synthCache.get(key);
        if (cached != null) {
            return wav(cached, true);
        }
        byte[] wav = synthesizeOrFail(text);
        // 只缓存小段：展厅的回答按句切片后多在几十 KB，而一次长文合成能到几 MB——按条数封顶的 LRU
        // 挡不住「64 条 × 数 MB」把堆占满，这里再加一道字节闸门。
        if (wav.length <= props.audioTtsCacheMaxBytes()) {
            synthCache.put(key, wav);
        }
        return wav(wav, false);
    }

    /**
     * 合成缓存的键：音色 + 风格 + 模型 + 文本都要进。
     *
     * <p>只按文本做键的话，运营改完 {@code AUDIO_STYLE}/{@code AUDIO_VOICE} 重启后，旧音频仍会在缓存里
     * 被命中——表现是「改了配置声音没变」，而且要到缓存自然淘汰或重启才恢复。
     */
    private String synthCacheKey(String text) {
        AppProperties.Audio audio = props.audio();
        String style = audio == null || audio.style() == null ? "" : audio.style();
        String model = audio == null || audio.ttsModel() == null ? "" : audio.ttsModel();
        return props.audioVoice() + "\u0000" + style + "\u0000" + model + "\u0000" + text;
    }

    /** 语音转文本：返回识别文本与音频时长（时长用于核对用量与排查「录到了静音」）。 */
    @PostMapping("/api/speech/recognize")
    public Map<String, Object> recognize(@RequestBody(required = false) Object body,
                                         HttpServletRequest request) {
        SpeechParser.Result<byte[]> parsed = SpeechParser.audio(body, props.audioMaxUploadBytes());
        if (!parsed.ok()) {
            throw ApiException.validation(SpeechParser.message(parsed.reason(), props.audioMaxUploadBytes(),
                    props.audioMaxChars()));
        }
        // 同 synthesize：先判入参形状，再看服务开不开（理由见上）
        requireEnabled();
        // 识别走自己的桶，与 /api/chat 的配额分立。旧版注释「一次语音提问就是一次提问」在点按式
        // 录音下成立，常开聆听下不成立：滚动的分段识别一次讲话就要连打多次 recognize，与提问共桶会
        // 瞬间把 30/min 打满、把真正的提问饿死。代价是识别不再受提问配额约束（识别本身很便宜、
        // 且不落库），提问仍由 /api/chat 自己的桶把关。
        limit(asrRateLimiter, request);
        long started = System.currentTimeMillis();
        SpeechModel.Recognition recognition;
        try {
            recognition = speech.recognize(parsed.value());
        } catch (DisabledSpeechModel.Unavailable e) {
            throw ApiException.speechUnavailable(e.getMessage());
        } catch (SpeechException e) {
            log.warn("[speech] 识别失败 status={} retryable={} err={}", e.status(), e.retryable(),
                    e.getMessage());
            // 上游的响应体（可能含服务端地址、错误码细节）只进日志，不回给前端：
            // 前端拿它也只是记进运营视图，没必要让浏览器看到上游长什么样。
            throw ApiException.speechFailed(UPSTREAM_FAILED_MESSAGE);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("text", recognition.text());
        out.put("seconds", recognition.seconds());
        out.put("elapsedMs", System.currentTimeMillis() - started);
        // 只记长度不记内容：录音是参观者说的话，展厅日志不该留全文（与 logMessageMode=preview 同一考量）。
        // 「0 字」不是故障：那是这段录音里没有可识别的话（静音/环境噪声），前端据此计一次空识别误触
        log.info("[speech] 识别完成 bytes={} 音频={}s 文本={}字 耗时={}ms",
                parsed.value().length, recognition.seconds(), recognition.text().length(),
                out.get("elapsedMs"));
        return out;
    }

    /**
     * 声学遥测：前端把本地只能观测到的量（底噪 RMS、VAD 判定、分段延迟）累加成**增量计数**批量送上来，
     * 后端只管相加（口径统一在 {@code Analytics#recordSpeech}）。
     *
     * <p>两条刻意的「不挂」：
     * <ul>
     *   <li><b>不挂 {@link #requireEnabled()}</b>：{@code AUDIO_PROVIDER=none} 时识别不可用，
     *       但「前端根本没能开麦/根本没配对」正是运营最需要看到的结论，跟着一起关掉等于把唯一的证据也删了；</li>
     *   <li><b>不挂管理口令</b>：运营面板没打开时数据同样要落库，否则统计变成「只在有人看的时候才准」。
     *       代价用限流 + 字段白名单 + 路径体积闸门兜住——它写的是没人读也不亏的计数器。</li>
     * </ul>
     */
    @PostMapping("/api/speech/metrics")
    public Map<String, Object> metrics(@RequestBody(required = false) Object body,
                                       HttpServletRequest request) {
        SpeechParser.Result<Map<String, Double>> parsed = SpeechParser.metrics(body);
        if (!parsed.ok()) {
            throw ApiException.validation(SpeechParser.message(parsed.reason(), props.audioMaxUploadBytes(),
                    props.audioMaxChars()));
        }
        limit(metricsRateLimiter, request);
        analytics.recordSpeech(parsed.value());
        return Map.of("ok", true);
    }

    private byte[] synthesizeOrFail(String text) {
        long started = System.currentTimeMillis();
        try {
            byte[] wav = speech.synthesize(text);
            log.debug("[speech] 合成 {} 字 → {} 字节，耗时 {}ms", text.length(), wav.length,
                    System.currentTimeMillis() - started);
            return wav;
        } catch (DisabledSpeechModel.Unavailable e) {
            throw ApiException.speechUnavailable(e.getMessage());
        } catch (SpeechException e) {
            log.warn("[speech] 合成失败 status={} retryable={} err={}", e.status(), e.retryable(), e.getMessage());
            throw ApiException.speechFailed(UPSTREAM_FAILED_MESSAGE);
        }
    }

    /** 语音未启用时提前拒绝：不落进解析与限流（那两条路径的错误信息会掩盖真正的原因） */
    private void requireEnabled() {
        if (!props.audioEnabled()) {
            throw ApiException.speechUnavailable("语音未启用（服务端 AUDIO_PROVIDER=none）");
        }
    }

    private void limit(RateLimiter limiter, HttpServletRequest request) {
        Long wait = limiter.allow(ClientIp.of(request.getHeader("x-forwarded-for"),
                request.getRemoteAddr(), props.trustForwardedFor()));
        if (wait != null) {
            throw ApiException.rateLimited(wait);
        }
    }

    private static ResponseEntity<byte[]> wav(byte[] body, boolean cached) {
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("audio/wav"))
                // 音频内容随文本变化而 POST 不可被浏览器复用，缓存交给服务端这份就够了
                .header("cache-control", "no-store")
                .header("x-znwd-speech", cached ? "cache" : "live")
                .body(body);
    }
}
