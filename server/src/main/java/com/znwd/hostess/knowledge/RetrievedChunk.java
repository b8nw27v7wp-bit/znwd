package com.znwd.hostess.knowledge;

import java.util.List;

/**
 * 关键词路命中。
 *
 * <p>两个分数刻意分开，别合成一个：
 * <ul>
 *   <li>{@code score}（排序分）含同义词扩展词，负责把「用户换个说法问」的资料排上来；</li>
 *   <li>{@code gateScore}（闸门分）**只算用户原话里出现的词条**。同义词表是提示不是要求，
 *       拿含扩展词的分去判定「这句话知识库覆不覆盖」，会让「光伏和风电哪个更赚钱」这类域外问题
 *       靠表里的泛词（组件/电站/清洗/积灰）攒够分数被放行（实测 10.96，高过在域最低 8.93）。</li>
 * </ul>
 *
 * @param score         该片段的相关性分（标题 / 展区 / 正文加权后归一化，含扩展词）
 * @param matchedTokens 命中的查询词条数（去重）
 * @param matched       命中的词条，按权重降序（便于阈值标定与日志排查）
 * @param gateScore     只由原查询词条贡献的相关性分（闸门用）
 */
public record RetrievedChunk(
        KnowledgeChunk chunk,
        double score,
        int matchedTokens,
        List<String> matched,
        double gateScore) {
}
