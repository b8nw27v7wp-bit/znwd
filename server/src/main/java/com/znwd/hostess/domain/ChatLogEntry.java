package com.znwd.hostess.domain;

import com.znwd.hostess.llm.LlmUsage;

/**
 * 一次问答的统计事件。
 *
 * @param noHit   相关性闸门拦截（知识库未覆盖）——运营据此补资料
 * @param question 仅 noHit 且开启留存时写入（明文，供补资料；不落完整日志）
 */
public record ChatLogEntry(
        long at,
        String sessionId,
        String mode,
        String provider,
        String messagePreview,
        Integer messageLen,
        String answerPreview,
        long latencyMs,
        boolean noHit,
        String retrieval,
        boolean rewritten,
        String question,
        LlmUsage usage,
        String error) {

    public String questionForUncovered() {
        return question == null || question.isBlank() ? null : question;
    }
}
