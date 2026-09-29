package com.znwd.hostess.audio;

/** 语音接口失败：可判定的原因（上游 HTTP 状态 / 空音频 / 解析失败），由路由层决定映射成什么响应。 */
public class SpeechException extends RuntimeException {

    private final int status;
    private final boolean retryable;

    public SpeechException(int status, String message, boolean retryable) {
        super(message);
        this.status = status;
        this.retryable = retryable;
    }

    /** 上游返回的 HTTP 状态（0 = 连不上/超时这类没有响应的情况） */
    public int status() {
        return status;
    }

    /** 重试是否有意义：429/5xx/网络抖动为 true，400/401 这类参数与鉴权问题为 false */
    public boolean retryable() {
        return retryable;
    }
}
