package com.znwd.hostess.llm;

import java.util.List;

/** 可插拔对话模型。实现：mock（无网关演示）/ openai_compat（内网网关或云端）。 */
public interface ChatModel {

    String name();

    /** 最近一次调用的 token 用量（流式也记），供统计与成本观察 */
    LlmUsage lastUsage();

    ChatCompletionResult complete(List<ChatMessage> messages);

    /**
     * 流式输出增量文本。
     *
     * @param onDelta 每拿到一段就回调（SSE 推送）；返回后不再有回调
     */
    void stream(List<ChatMessage> messages, java.util.function.Consumer<String> onDelta);

    record ChatCompletionResult(String content, String provider, LlmUsage usage) {
    }
}
