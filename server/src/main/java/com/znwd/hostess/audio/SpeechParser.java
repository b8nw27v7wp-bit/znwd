package com.znwd.hostess.audio;

import java.util.Base64;
import java.util.Map;

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
        AUDIO_TOO_LARGE
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
