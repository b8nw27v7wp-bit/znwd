package com.znwd.hostess.audio;

import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * 语音接口的入参解析：与 {@code RequestParser} 同样的收敛风格——所有错误都落到可判定的原因码，
 * 由路由层统一转 400，不允许 500。
 *
 * <p>音频只收 WAV：前端用 AudioContext 采 PCM 自拼 16kHz 单声道 WAV，天然就是它；
 * 放 mp3/webm 进来只会让「浏览器录到的格式与接口要的格式不一致」这种问题在运行时才暴露。
 */
public final class SpeechParser {

    private SpeechParser() {
    }

    public static Result<String> text(Object body, int maxChars) {
        if (!(body instanceof Map<?, ?> map)) {
            return Result.failure(Reason.BODY_NOT_OBJECT);
        }
        Object raw = map.get("text");
        if (!(raw instanceof String text)) {
            return Result.failure(Reason.TEXT_MISSING);
        }
        String trimmed = text.strip();
        if (trimmed.isEmpty()) {
            return Result.failure(Reason.TEXT_MISSING);
        }
        if (trimmed.length() > maxChars) {
            return Result.failure(Reason.TEXT_TOO_LONG);
        }
        return Result.success(trimmed);
    }

    /**
     * 解析 {@code {"audio": "data:audio/wav;base64,..."}}（也接受不带 {@code data:} 前缀的裸 base64）。
     */
    public static Result<byte[]> audio(Object body, long maxBytes) {
        if (!(body instanceof Map<?, ?> map)) {
            return Result.failure(Reason.BODY_NOT_OBJECT);
        }
        Object raw = map.get("audio");
        if (!(raw instanceof String payload) || payload.isBlank()) {
            return Result.failure(Reason.AUDIO_MISSING);
        }
        String encoded = payload.strip();
        if (encoded.startsWith("data:")) {
            int comma = encoded.indexOf(',');
            if (comma < 0) {
                return Result.failure(Reason.AUDIO_BAD_ENCODING);
            }
            String mime = encoded.substring(5, comma).toLowerCase();
            if (!mime.startsWith("audio/wav") && !mime.startsWith("audio/x-wav")) {
                return Result.failure(Reason.AUDIO_UNSUPPORTED_FORMAT);
            }
            encoded = encoded.substring(comma + 1);
        }
        // base64 的长度先卡一道：解码前就拒掉超大载荷，避免为了判断大小先去分配内存
        if (encoded.length() > maxBytes / 3 * 4 + 8) {
            return Result.failure(Reason.AUDIO_TOO_LARGE);
        }
        byte[] wav;
        try {
            wav = Base64.getDecoder().decode(encoded.replaceAll("\\s", ""));
        } catch (IllegalArgumentException e) {
            return Result.failure(Reason.AUDIO_BAD_ENCODING);
        }
        if (wav.length > maxBytes) {
            return Result.failure(Reason.AUDIO_TOO_LARGE);
        }
        // 44 字节是 WAV 头的最小长度；只认 RIFF/WAVE，避免把 JSON 错误体之类的东西送去识别
        if (!isWav(wav)) {
            return Result.failure(Reason.AUDIO_UNSUPPORTED_FORMAT);
        }
        // 只有头、没有采样：本地就该拒。放过去的话上游会回 500，客户端等完重试才拿到 502——
        // 边界探测 W08 就是这么打出来的（44 字节的空 WAV）。
        if (wav.length <= 44) {
            return Result.failure(Reason.AUDIO_EMPTY);
        }
        return Result.success(wav);
    }

    /**
     * 声学遥测的字段白名单（{@code POST /api/speech/metrics}）。
     *
     * <p>未知键一律拒而不是静默忽略：前端把字段名拼错时，静默忽略的表现是「运营面板上这一行永远是 0」——
     * 没有报错、没有日志，只有人到现场比对才发现。白名单把这类问题变成一次看得见的 400。
     *
     * <p>体积也因此自封顶：至多 {@code size()} 个有限数值能落进 Analytics（原始字节由
     * {@code /api/speech/*} 的 2MB 路径闸门兜住，见 {@code web/RequestSizeLimitFilter}）。
     */
    public static final Set<String> METRIC_KEYS = Set.of(
            // —— 语句与 VAD
            "utterances",           // 语句数（自动 + 手动 + 超时结束）
            "autoEnds",             // 停顿自动收尾
            "manualEnds",           // 点按手动结束
            "noSpeechAborts",       // 开麦后一直没人说话，超时收回
            "falseTriggers",        // 整段识别回空——环境噪声被当成了说话
            "suspectedTruncations", // 自动收尾后马上又起一句：疑似被静音阈值截成两句
            "suppressedAbandons",   // 播报期间撤回的语句
            // —— 分段识别
            "segmentCalls",         // 分段识别调用（含失败）
            "segmentFailures",      // 分段识别失败（含 429/超时）
            "segmentDropped",       // 并发上限挡下的分段（连一段都没发出去）
            "segmentAudioMs",       // 分段识别的音频时长之和（计费口径）
            "partialLatencySumMs",  // 分段识别耗时之和
            "partialLatencyCount",  // 分段识别成功次数
            // —— 底噪与自适应阈值
            "noiseFloorSum",        // 底噪 RMS 之和（均值在服务端算）
            "noiseSamples",         // 底噪采样次数
            "thresholdSum",         // 自适应后的说话阈值之和
            "thresholdSamples",     // 自适应阈值的采样次数
            // —— 终稿（整段识别）
            "finalCalls",           // 整段识别返回次数（失败不计）
            "finalEndDelaySumMs",   // 说完 → VAD 判出收尾
            "finalLatencySumMs",    // 说完 → 终稿文本（含上一项）
            "finalServerSumMs",     // 服务端自己量的识别耗时（与上一项之差是浏览器侧开销）
            "finalAudioMs",         // 整段识别的音频时长之和（计费口径）
            // —— 播报期间的回声与插话（P3a）
            "echoSamples",          // 播报期间采到的块数
            "echoFloorSum",         // 这些块的 RMS 之和（自己的喇叭在麦克风里有多响）
            "echoOverCount",        // 越过当前说话阈值的块数
            "echoFarOverCount",     // 越过插话门限（阈值 × BARGEIN_FACTOR）的块数
            "bargeIns",             // 判出的插话次数
            "bargeInRejected",      // 插话判错的次数（falseTriggers 的子集）
            // —— 回答链路（§4 P2 修订 1 的后两段）
            "firstSentenceSumMs",   // 提问发出 → 首句生成（语音终稿与打字提交都计入，量的是回答链路）
            "firstSentenceCount",
            "firstAudioSumMs",      // 首句生成 → 首段音频开始播
            "firstAudioCount");

    /** 遥测单项的数值上限：计数是要累加的，一条 NaN/Infinity/负数就能把运营面板永久污染 */
    public static final double METRIC_MAX_VALUE = 1e6;

    /**
     * 解析声学遥测的增量计数：{@code {"utterances": 3, "noiseSamples": 12, ...}}。
     *
     * <p>只收 {@link #METRIC_KEYS} 里的键、且值必须是「有限、非负、不超过 {@link #METRIC_MAX_VALUE}」的数值：
     * 内存计数器没有回退路径，一条坏数据进去，重启前运营面板读到的都是错的——在这里拒掉，
     * 比让运营去现场猜「底噪为什么是 NaN」便宜得多。
     *
     * <p>空对象合法：回一个空 map，由调用方决定要不要落库（前端攒不到东西就不该发，但发来了不算错）。
     */
    public static Result<Map<String, Double>> metrics(Object body) {
        if (!(body instanceof Map<?, ?> map)) {
            return Result.failure(Reason.BODY_NOT_OBJECT);
        }
        Map<String, Double> out = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (!(entry.getKey() instanceof String key) || !METRIC_KEYS.contains(key)) {
                return Result.failure(Reason.METRICS_UNKNOWN_FIELD);
            }
            if (!(entry.getValue() instanceof Number number)) {
                return Result.failure(Reason.METRICS_BAD_VALUE);
            }
            double value = number.doubleValue();
            if (!Double.isFinite(value) || value < 0 || value > METRIC_MAX_VALUE) {
                return Result.failure(Reason.METRICS_BAD_VALUE);
            }
            out.put(key, value);
        }
        return Result.success(out);
    }

    static boolean isWav(byte[] wav) {
        if (wav == null || wav.length < 44
                || wav[0] != 'R' || wav[1] != 'I' || wav[2] != 'F' || wav[3] != 'F'
                || wav[8] != 'W' || wav[9] != 'A' || wav[10] != 'V' || wav[11] != 'E'
                || wav[12] != 'f' || wav[13] != 'm' || wav[14] != 't' || wav[15] != ' '
                || wav[36] != 'd' || wav[37] != 'a' || wav[38] != 't' || wav[39] != 'a') {
            return false;
        }
        long riffSize = readLe32(wav, 4);
        long dataSize = readLe32(wav, 40);
        return riffSize + 8 <= wav.length && dataSize <= wav.length - 44L;
    }

    private static long readLe32(byte[] data, int offset) {
        return (data[offset] & 0xffL)
                | ((data[offset + 1] & 0xffL) << 8)
                | ((data[offset + 2] & 0xffL) << 16)
                | ((data[offset + 3] & 0xffL) << 24);
    }

    public static String message(Reason reason, long maxUploadBytes, int maxChars) {
        return switch (reason) {
            case BODY_NOT_OBJECT -> "请求体必须是 JSON 对象";
            case TEXT_MISSING -> "text 必填且不能为空白";
            case TEXT_TOO_LONG -> "text 过长（单次合成上限 " + maxChars + " 字，请按句切片后再请求）";
            case AUDIO_MISSING -> "audio 必填";
            case AUDIO_BAD_ENCODING -> "audio 不是合法的 base64（应为 data:audio/wav;base64,... 或裸 base64）";
            case AUDIO_UNSUPPORTED_FORMAT -> "audio 只支持 WAV（16bit PCM）";
            case AUDIO_EMPTY -> "录音里没有音频数据（只有 WAV 头，通常是传了空录音上来）";
            case AUDIO_TOO_LARGE -> "录音过大（上限 " + (maxUploadBytes / 1024) + "KB，约 "
                    + (maxUploadBytes / 32000) + " 秒）";
            case METRICS_UNKNOWN_FIELD -> "声学遥测含未知字段（只接受约定的计数键，见 docs/api.md）";
            case METRICS_BAD_VALUE -> "声学遥测的值必须是有限、非负、不超过 "
                    + (long) METRIC_MAX_VALUE + " 的数值";
        };
    }

    public enum Reason {
        BODY_NOT_OBJECT,
        TEXT_MISSING,
        TEXT_TOO_LONG,
        AUDIO_MISSING,
        AUDIO_BAD_ENCODING,
        AUDIO_UNSUPPORTED_FORMAT,
        AUDIO_EMPTY,
        AUDIO_TOO_LARGE,
        METRICS_UNKNOWN_FIELD,
        METRICS_BAD_VALUE
    }

    public record Result<T>(boolean ok, T value, Reason reason) {

        static <T> Result<T> success(T value) {
            return new Result<>(true, value, null);
        }

        static <T> Result<T> failure(Reason reason) {
            return new Result<>(false, null, reason);
        }
    }
}
