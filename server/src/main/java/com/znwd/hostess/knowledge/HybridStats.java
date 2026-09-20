package com.znwd.hostess.knowledge;

/** 检索层总体状态（健康检查上报）。 */
public record HybridStats(
        RetrievalMode mode,
        int keywordChunks,
        VectorStats vector,
        boolean indexReady,
        long generation,
        boolean semantic,
        String degradedReason,
        RetrievalDiagnostics.Thresholds thresholds) {
}
