package com.znwd.hostess.web;

import java.util.Map;

import org.springframework.http.HttpStatus;

/** 可判定的接口异常：由 GlobalExceptionHandler 转成统一错误信封。 */
public class ApiException extends RuntimeException {

    private final HttpStatus status;
    private final String code;
    private final Map<String, Object> extra;

    public ApiException(HttpStatus status, String code, String message) {
        this(status, code, message, null);
    }

    public ApiException(HttpStatus status, String code, String message, Map<String, Object> extra) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra;
    }

    public HttpStatus status() {
        return status;
    }

    public String code() {
        return code;
    }

    public Map<String, Object> extra() {
        return extra;
    }

    public static ApiException validation(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, com.znwd.hostess.http.ApiError.VALIDATION_ERROR, message);
    }

    public static ApiException unauthorized() {
        return new ApiException(HttpStatus.UNAUTHORIZED, com.znwd.hostess.http.ApiError.UNAUTHORIZED, "unauthorized");
    }

    public static ApiException notFound(String message) {
        return new ApiException(HttpStatus.NOT_FOUND, com.znwd.hostess.http.ApiError.NOT_FOUND, message);
    }

    public static ApiException rateLimited(long retryAfterSec) {
        return new ApiException(HttpStatus.TOO_MANY_REQUESTS, com.znwd.hostess.http.ApiError.RATE_LIMITED,
                "too many requests", Map.of("retryAfterSec", retryAfterSec));
    }
}
