package com.znwd.hostess.knowledge;

/**
 * 把检索诊断翻成一句人话：排查"这句话为什么被拦 / 为什么命中"时先看这里。
 *
 * <p>纯函数（只依赖 {@link RetrievalDiagnostics}），所以能被单测钉住文案与阈值判断，
 * 而不是靠人去读日志猜。
 */
public final class RetrievalVerdict {

    private RetrievalVerdict() {
    }

    public static String describe(RetrievalDiagnostics d) {
        if (d == null) {
            return "无诊断信息";
        }
        double min = d.thresholds() == null ? 0 : d.thresholds().minKeywordScore();
        double best = d.keywordBestScore();
        String gap = String.format("关键词最高 %.2f / 阈值 %.2f", best, min);

        if (d.gated()) {
            if (d.reason() == RetrievalReason.NO_CANDIDATES) {
                return "闸门拦下：没有任何候选片段（这句话与资料几乎没有词重叠，属于域外问题），"
                        + "上层按「资料里没有」回答";
            }
            String vectorNote = d.semantic()
                    ? String.format("语义向量最高余弦 %.3f 也没过阈值 %.2f", d.vectorBestCosine(),
                            d.thresholds() == null ? 0 : d.thresholds().minVectorScore())
                    : "语义向量不可用（" + degradedNote(d) + "），只剩关键词路";
            return "闸门拦下：有候选但相关度不够（" + gap + "；" + vectorNote + "）";
        }

        if (d.reason() == RetrievalReason.VECTOR_HIT) {
            return "命中：关键词路没过阈值（" + gap + "），靠语义向量救回";
        }
        String margin = String.format("余量 %.2f", best - min);
        String degraded = d.semantic() ? "" : "；注意语义向量不可用（" + degradedNote(d) + "），本次是纯关键词检索";
        return "命中：关键词路直接通过（" + gap + "，" + margin + "）" + degraded;
    }

    private static String degradedNote(RetrievalDiagnostics d) {
        return d.degraded() ? "当前为降级模式" : "未启用";
    }

    /** 距离阈值还差多少（正数=还差这么多，负数/零=已过阈值），标定时用来判断"卡边" */
    public static double distanceToGate(RetrievalDiagnostics d) {
        if (d == null || d.thresholds() == null) {
            return 0;
        }
        return round(d.thresholds().minKeywordScore() - d.keywordBestScore(), 3);
    }

    private static double round(double value, int digits) {
        double factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }
}
