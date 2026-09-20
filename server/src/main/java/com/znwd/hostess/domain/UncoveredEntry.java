package com.znwd.hostess.domain;

/** 知识库未覆盖的原始提问（明文、限量），是下一批要补的知识清单。 */
public record UncoveredEntry(long at, String sessionId, String question) {
}
