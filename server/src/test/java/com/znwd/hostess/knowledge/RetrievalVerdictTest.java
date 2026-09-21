package com.znwd.hostess.knowledge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** 诊断文案与"离阈值还差多少"：运维靠这句话判案，所以要被测试钉住。 */
class RetrievalVerdictTest {

    private static RetrievalDiagnostics diag(RetrievalMode mode, boolean semantic, boolean gated,
                                            RetrievalReason reason, double gateScore, double vectorBest,
                                            double minKeyword, double minVector) {
        // 第 6 个参数是闸门分、第 7 个是排序分：闸门只认前者，这里让两者相等把差异隔离掉
        return new RetrievalDiagnostics(mode, semantic, !semantic, gated, reason, gateScore, gateScore,
                vectorBest, 5, new RetrievalDiagnostics.Thresholds(minKeyword, minVector));
    }

    @Test
    @DisplayName("域外问题被拦：说清是「没有候选」还是「相关度不够」")
    void gatedMessages() {
        String noCandidates = RetrievalVerdict.describe(diag(RetrievalMode.KEYWORD, false, true,
                RetrievalReason.NO_CANDIDATES, 0.0, 0.05, 3.8, 0.35));
        assertTrue(noCandidates.contains("闸门拦下"), noCandidates);
        assertTrue(noCandidates.contains("域外"), noCandidates);

        String below = RetrievalVerdict.describe(diag(RetrievalMode.KEYWORD, false, true,
                RetrievalReason.BELOW_THRESHOLD, 2.64, 0.9, 3.8, 0.35));
        assertTrue(below.contains("相关度不够"), below);
        assertTrue(below.contains("2.64"), below);
        assertTrue(below.contains("3.80") || below.contains("3.8"), below);
    }

    @Test
    @DisplayName("命中：关键词路要说余量，向量救回要另说一句")
    void hitMessages() {
        String keyword = RetrievalVerdict.describe(diag(RetrievalMode.KEYWORD, false, false,
                RetrievalReason.KEYWORD_HIT, 12.5, 0.0, 3.8, 0.35));
        assertTrue(keyword.contains("命中"), keyword);
        assertTrue(keyword.contains("余量 8.7"), keyword);

        String vector = RetrievalVerdict.describe(diag(RetrievalMode.HYBRID, true, false,
                RetrievalReason.VECTOR_HIT, 1.2, 0.62, 3.8, 0.35));
        assertTrue(vector.contains("语义向量救回"), vector);
    }

    @Test
    @DisplayName("两个分数不一致时，人话结论报的是闸门实际比较的那个分")
    void reportsComparedScore() {
        // 排序分 12.0 过线、只算用户原话的分 7.0：闸门比较的是 12.0，文案必须报 12.0 并附上 7.0
        RetrievalDiagnostics d = new RetrievalDiagnostics(RetrievalMode.KEYWORD, false, true, false,
                RetrievalReason.KEYWORD_HIT, 7.0, 12.0, 0.0, 5,
                new RetrievalDiagnostics.Thresholds(3.8, 0.35));
        String text = RetrievalVerdict.describe(d);
        assertTrue(text.contains("12.00"), text);
        assertTrue(text.contains("7.00"), text);
        assertEquals(-8.2, RetrievalVerdict.distanceToGate(d), 1e-9);
    }

    @Test
    @DisplayName("距离阈值：正数=还差多少，负数=已过阈值")
    void distance() {
        assertEquals(1.2, RetrievalVerdict.distanceToGate(diag(RetrievalMode.KEYWORD, false, true,
                RetrievalReason.BELOW_THRESHOLD, 2.6, 0.0, 3.8, 0.35)), 1e-9);
        assertEquals(-6.2, RetrievalVerdict.distanceToGate(diag(RetrievalMode.KEYWORD, false, false,
                RetrievalReason.KEYWORD_HIT, 10.0, 0.0, 3.8, 0.35)), 1e-9);
        assertEquals(0, RetrievalVerdict.distanceToGate(null), 1e-9);
    }
}
