package com.znwd.hostess.knowledge;

import java.util.List;

/**
 * 融合后的命中。
 *
 * @param keywordScore 关键词路原始分
 * @param vectorScore  向量路余弦
 * @param fuseScore    RRF 融合分（两路都命中时有微小加成）
 */
public record HybridHit(
        String id,
        String title,
        String sourcePath,
        String text,
        String zone,
        String zoneTitle,
        List<String> tags,
        double score,
        double keywordScore,
        double vectorScore,
        int matchedTokens,
        List<String> matched,
        double fuseScore) {

    public static HybridHit of(KnowledgeChunk chunk, double score, double keywordScore, double vectorScore,
                               int matchedTokens, List<String> matched, double fuseScore) {
        return new HybridHit(chunk.id(), chunk.title(), chunk.sourcePath(), chunk.text(), chunk.zone(),
                chunk.zoneTitle(), chunk.tags(), score, keywordScore, vectorScore, matchedTokens, matched, fuseScore);
    }
}
