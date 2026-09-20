package com.znwd.hostess.knowledge;

/** 向量索引状态（健康检查与 /api/knowledge/list 上报）。 */
public record VectorStats(
        String provider,
        boolean semantic,
        int dims,
        int vectors,
        String fingerprint,
        String indexFile) {
}
