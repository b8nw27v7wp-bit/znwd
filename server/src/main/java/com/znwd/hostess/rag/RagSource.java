package com.znwd.hostess.rag;

/**
 * 回答里引用的知识片段（前端「来源」区与运营溯源用）。
 *
 * @param vectorScore  语义路余弦（未参与时为 0）
 * @param keywordScore 关键词路原始分
 */
public record RagSource(
        String title,
        String snippet,
        double score,
        String sourcePath,
        String zone,
        String zoneTitle,
        double vectorScore,
        double keywordScore) {
}
