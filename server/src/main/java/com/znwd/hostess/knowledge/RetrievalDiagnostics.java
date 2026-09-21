package com.znwd.hostess.knowledge;

/**
 * 检索诊断信息：出问题时先看这里（模式、是否降级、闸门是否拦截、分数余量）。
 *
 * @param keywordGateScore 闸门分：只由用户原话的词条贡献（闸门比较的就是它）
 * @param keywordBestScore 排序分：含同义词扩展词，用于把候选片段排上来
 */
public record RetrievalDiagnostics(
        RetrievalMode mode,
        boolean semantic,
        boolean degraded,
        boolean gated,
        RetrievalReason reason,
        double keywordGateScore,
        double keywordBestScore,
        double vectorBestCosine,
        int candidates,
        Thresholds thresholds) {

    public record Thresholds(double minKeywordScore, double minVectorScore) {
    }
}
