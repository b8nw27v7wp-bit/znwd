package com.znwd.hostess.knowledge;

import com.fasterxml.jackson.annotation.JsonValue;

/** 闸门判定原因，用于排查「为什么这条被拦」而不是只看一个空结果。 */
public enum RetrievalReason {
    KEYWORD_HIT("keyword_hit"),
    VECTOR_HIT("vector_hit"),
    BELOW_THRESHOLD("below_threshold"),
    NO_CANDIDATES("no_candidates");

    private final String value;

    RetrievalReason(String value) {
        this.value = value;
    }

    @JsonValue
    public String value() {
        return value;
    }
}
