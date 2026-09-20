package com.znwd.hostess.knowledge;

import java.util.List;

/**
 * 关键词路命中。
 *
 * @param score         该片段的相关性分（标题 / 展区 / 正文加权后归一化）
 * @param matchedTokens 命中的查询词条数（去重）
 * @param matched       命中的词条，按权重降序（便于阈值标定与日志排查）
 */
public record RetrievedChunk(
        KnowledgeChunk chunk,
        double score,
        int matchedTokens,
        List<String> matched) {
}
