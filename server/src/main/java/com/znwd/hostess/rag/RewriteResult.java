package com.znwd.hostess.rag;

import java.util.List;

/**
 * 多轮指代改写结果。
 *
 * @param query          用于检索的查询串（未改写时等于原问题）
 * @param carriedTokens  从上一轮问题继承的主题词
 * @param carriedTopic   主题词来源的片段标题（排查用）
 */
public record RewriteResult(
        String query,
        boolean rewritten,
        RewriteReason reason,
        List<String> carriedTokens,
        String carriedTopic) {

    public static RewriteResult unchanged(String query, RewriteReason reason) {
        return new RewriteResult(query, false, reason, List.of(), null);
    }

    public enum RewriteReason {
        NONE("none"),
        NO_HISTORY("no_history"),
        PREV_WEAK("prev_weak"),
        ELLIPSIS_MERGED("ellipsis_merged");

        private final String value;

        RewriteReason(String value) {
            this.value = value;
        }

        @com.fasterxml.jackson.annotation.JsonValue
        public String value() {
            return value;
        }
    }
}
