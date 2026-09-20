package com.znwd.hostess.knowledge;

/** 检索模式，如实上报：只有语义向量真的参与融合时才算 hybrid。 */
public enum RetrievalMode {
    KEYWORD("keyword"),
    HYBRID("hybrid");

    private final String value;

    RetrievalMode(String value) {
        this.value = value;
    }

    @com.fasterxml.jackson.annotation.JsonValue
    public String value() {
        return value;
    }
}
