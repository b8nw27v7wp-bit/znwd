package com.znwd.hostess.llm;

/**
 * token 用量（网关返回 usage 时才有）。
 *
 * <p>记录它是为了成本可见：展厅每天几十上百次问答，接付费模型后这是唯一能对账的数字。
 */
public record LlmUsage(
        Integer promptTokens,
        Integer completionTokens,
        Integer reasoningTokens,
        Integer totalTokens) {

    public boolean hasAny() {
        return nonZero(promptTokens) || nonZero(completionTokens) || nonZero(totalTokens);
    }

    private static boolean nonZero(Integer v) {
        return v != null && v != 0;
    }
}
