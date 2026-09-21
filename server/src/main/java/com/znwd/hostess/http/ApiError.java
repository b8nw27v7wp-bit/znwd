package com.znwd.hostess.http;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 统一错误信封：{@code {error, message, requestId, ...extra}}。
 *
 * <p>对外只给可判定的错误码与固定文案，堆栈与内部细节只进服务端日志——展厅大屏上出现 Java 异常名
 * 既难看又泄露实现。
 */
public final class ApiError {

    public static final String VALIDATION_ERROR = "validation_error";
    public static final String NOT_FOUND = "not_found";
    public static final String METHOD_NOT_ALLOWED = "method_not_allowed";
    public static final String UNSUPPORTED_MEDIA_TYPE = "unsupported_media_type";
    public static final String UNAUTHORIZED = "unauthorized";
    public static final String RATE_LIMITED = "rate_limited";
    public static final String INTERNAL_ERROR = "internal_error";

    private ApiError() {
    }

    public static Map<String, Object> payload(String code, String message, String requestId) {
        return payload(code, message, requestId, null);
    }

    public static Map<String, Object> payload(String code, String message, String requestId, Map<String, Object> extra) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", code);
        body.put("message", message);
        body.put("requestId", requestId == null ? "" : requestId);
        if (extra != null) {
            body.putAll(extra);
        }
        return body;
    }
}
