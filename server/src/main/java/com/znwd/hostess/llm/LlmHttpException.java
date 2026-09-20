package com.znwd.hostess.llm;

/**
 * 模型网关调用失败。
 *
 * @param status     HTTP 状态码；业务错误码包装成 200 时也是 200
 * @param body       响应体（截断），用于判断是否可重试
 * @param retryAfter Retry-After 头（秒）
 */
public class LlmHttpException extends RuntimeException {

    private final int status;
    private final String body;
    private final String retryAfter;

    public LlmHttpException(int status, String body, String message, String retryAfter) {
        super(message);
        this.status = status;
        this.body = body;
        this.retryAfter = retryAfter;
    }

    public int status() {
        return status;
    }

    public String body() {
        return body;
    }

    public String retryAfter() {
        return retryAfter;
    }
}
