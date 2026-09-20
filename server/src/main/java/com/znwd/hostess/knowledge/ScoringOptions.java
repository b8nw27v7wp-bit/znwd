package com.znwd.hostess.knowledge;

/**
 * 关键词路打分参数。
 *
 * <p>默认值由网格搜索选出（旧版 tune-scoring.mjs，现为 {@code mvn exec:java@calibrate --grid}）：
 * top1 0.9333 / top3 0.9667——多次网格重跑没有任何一组能超过这组默认值，所以保持不动。
 * 改语料或改同义词表后要重跑标定，不要凭手感改这里的常数。
 *
 * @param titleBoost      命中标题的加权
 * @param zoneBoost       命中展区名/标签的加权
 * @param bodyBoost       命中正文的加权
 * @param expansionWeight 同义词扩展词权重（扩展是提示不是要求，原查询词为 1）
 * @param maxTfBoost      词频增益上限：长文档靠反复出现某个泛词取胜是噪声，不是相关性
 * @param lengthB         正文长度归一化强度（BM25 的 b），0 = 关闭
 */
public record ScoringOptions(
        double titleBoost,
        double zoneBoost,
        double bodyBoost,
        double expansionWeight,
        double maxTfBoost,
        double lengthB) {

    public static final double DEFAULT_TITLE_BOOST = 2.2;
    public static final double DEFAULT_EXPANSION_WEIGHT = 0.45;
    public static final double DEFAULT_MAX_TF_BOOST = 2.2;

    public static ScoringOptions defaults() {
        return new ScoringOptions(DEFAULT_TITLE_BOOST, 1.0, 1.0, DEFAULT_EXPANSION_WEIGHT, DEFAULT_MAX_TF_BOOST, 0.0);
    }
}
