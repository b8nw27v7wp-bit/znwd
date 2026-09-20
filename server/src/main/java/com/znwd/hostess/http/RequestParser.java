package com.znwd.hostess.http;

import java.util.regex.Pattern;

/**
 * 请求入参解析：所有错误都收敛为可判定的原因码，路由层统一转 400，不再抛 500。
 */
public final class RequestParser {

    public static final int MESSAGE_MAX_CHARS = 2000;
    public static final int SESSION_ID_MAX_CHARS = 64;

    /** sessionId 只作内存会话键与日志字段，不做路径：非法字符直接剔除，避免控制字符进入日志 */
    private static final Pattern SESSION_ID_UNSAFE = Pattern.compile("[^A-Za-z0-9._-]");

    private RequestParser() {
    }

    public static String normalizeSessionId(String raw) {
        if (raw == null) {
            return null;
        }
        String cleaned = SESSION_ID_UNSAFE.matcher(raw).replaceAll("");
        if (cleaned.length() > SESSION_ID_MAX_CHARS) {
            cleaned = cleaned.substring(0, SESSION_ID_MAX_CHARS);
        }
        return cleaned.isEmpty() ? null : cleaned;
    }

    public static String validationMessage(Reason reason) {
        return switch (reason) {
            case MESSAGE_NOT_STRING -> "message must be a string";
            case MESSAGE_EMPTY, BODY_NOT_OBJECT -> "message is required";
        };
    }

    /**
     * @param message 已 trim 并按上限截断
     */
    public static ParseResult parseChatInput(Object body) {
        if (!(body instanceof java.util.Map<?, ?> map)) {
            return ParseResult.failure(Reason.BODY_NOT_OBJECT);
        }
        Object raw = map.get("message");
        if (raw != null && !(raw instanceof String)) {
            return ParseResult.failure(Reason.MESSAGE_NOT_STRING);
        }
        String message = raw == null ? "" : ((String) raw).strip();
        if (message.isEmpty()) {
            return ParseResult.failure(Reason.MESSAGE_EMPTY);
        }
        boolean truncated = message.length() > MESSAGE_MAX_CHARS;
        return ParseResult.success(new ChatInput(
                truncated ? message.substring(0, MESSAGE_MAX_CHARS) : message,
                normalizeSessionId(map.get("sessionId") instanceof String s ? s : null),
                truncated));
    }

    public enum Reason {
        BODY_NOT_OBJECT,
        MESSAGE_NOT_STRING,
        MESSAGE_EMPTY
    }

    public record ChatInput(String message, String sessionId, boolean truncated) {
    }

    public record ParseResult(boolean ok, ChatInput value, Reason reason) {

        public static ParseResult success(ChatInput value) {
            return new ParseResult(true, value, null);
        }

        public static ParseResult failure(Reason reason) {
            return new ParseResult(false, null, reason);
        }
    }
}
