package com.znwd.hostess.knowledge;

/**
 * 检索诊断信息：出问题时先看这里（模式、是否降级、闸门是否拦截、分数余量）。
 */
public record RetrievalDiagnostics(
        RetrievalMode mode,
        boolean semantic,
        boolean degraded,
        boolean gated,
        RetrievalReason reason,
        double keywordBestScore,
        double vectorBestCosine,
        int candidates,
        Thresholds thresholds) {

    public record Thresholds(double minKeywordScore, double minVectorScore) {
    }
}
