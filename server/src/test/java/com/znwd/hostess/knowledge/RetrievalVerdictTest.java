package com.znwd.hostess.knowledge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** 诊断文案与"离阈值还差多少"：运维靠这句话判案，所以要被测试钉住。 */
class RetrievalVerdictTest {

    private static RetrievalDiagnostics diag(RetrievalMode mode, boolean semantic, boolean gated,
                                            RetrievalReason reason, double keywordBest, double vectorBest,
                                            double minKeyword, double minVector) {
        return new RetrievalDiagnostics(mode, semantic, !semantic, gated, reason, keywordBest, vectorBest, 5,
                new RetrievalDiagnostics.Thresholds(minKeyword, minVector));
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
    @DisplayName("距离阈值：正数=还差多少，负数=已过阈值")
    void distance() {
        assertEquals(1.2, RetrievalVerdict.distanceToGate(diag(RetrievalMode.KEYWORD, false, true,
                RetrievalReason.BELOW_THRESHOLD, 2.6, 0.0, 3.8, 0.35)), 1e-9);
        assertEquals(-6.2, RetrievalVerdict.distanceToGate(diag(RetrievalMode.KEYWORD, false, false,
                RetrievalReason.KEYWORD_HIT, 10.0, 0.0, 3.8, 0.35)), 1e-9);
        assertEquals(0, RetrievalVerdict.distanceToGate(null), 1e-9);
    }
}
