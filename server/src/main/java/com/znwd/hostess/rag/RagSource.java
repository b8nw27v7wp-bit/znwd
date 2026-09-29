package com.znwd.hostess.rag;

/**
 * 回答里引用的知识片段（前端「来源」区与运营溯源用）。
 *
 * <p>{@code snippet} 是固定前 200 字的列表摘要；需要在原文里定位时用 {@code chunkText} +
 * {@code matchTerm}/{@code matchOffset}：{@code chunkText} 是完整分块原文（超长截断到
 * {@link RagPipeline#CHUNK_TEXT_MAX} 字），{@code matchTerm} 在其中按 {@code matchOffset}
 * 可直接高亮（两者同时缺失/为 -1 = 本次没有可在正文里定位的命中词，只展示原文即可）。
 *
 * @param vectorScore  语义路余弦（未参与时为 0）
 * @param keywordScore 关键词路原始分
 * @param chunkText    命中分块的完整原文（≤ {@link RagPipeline#CHUNK_TEXT_MAX} 字）
 * @param matchTerm    本次命中的关键词，在 {@code chunkText} 中原样出现（定位不到时为 null，JSON 里缺省）
 * @param matchOffset  {@code matchTerm} 在 {@code chunkText} 中的字符偏移（-1 = 未定位到）
 */
public record RagSource(
        String title,
        String snippet,
        double score,
        String sourcePath,
        String zone,
        String zoneTitle,
        double vectorScore,
        double keywordScore,
        String chunkText,
        String matchTerm,
        int matchOffset) {
}
