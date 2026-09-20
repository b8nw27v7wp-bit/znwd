package com.znwd.hostess.llm;

/** 对话角色（与 OpenAI 兼容协议一致）。 */
public enum ChatRole {
    SYSTEM("system"),
    USER("user"),
    ASSISTANT("assistant");

    private final String value;

    ChatRole(String value) {
        this.value = value;
    }

    public String value() {
        return value;
    }
}
