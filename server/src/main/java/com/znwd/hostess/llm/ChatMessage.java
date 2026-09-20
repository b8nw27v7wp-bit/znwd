package com.znwd.hostess.llm;

/** 单轮消息。 */
public record ChatMessage(ChatRole role, String content) {

    public static ChatMessage system(String content) {
        return new ChatMessage(ChatRole.SYSTEM, content);
    }

    public static ChatMessage user(String content) {
        return new ChatMessage(ChatRole.USER, content);
    }

    public static ChatMessage assistant(String content) {
        return new ChatMessage(ChatRole.ASSISTANT, content);
    }
}
