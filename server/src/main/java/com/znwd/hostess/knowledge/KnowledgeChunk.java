package com.znwd.hostess.knowledge;

import java.util.List;

/**
 * 检索最小单元：一篇知识文档按标题切分后的一段，带展区归属便于按展区推荐与溯源。
 *
 * @param id         稳定标识，形如 {@code 01_光伏清洁无人机/产品概述.md#0}
 * @param title      文档标题（frontmatter title 或首个一级标题）
 * @param sourcePath 相对 knowledge/ 的路径
 * @param text       片段正文（含标题上下文）
 * @param zone       展区 id
 * @param zoneTitle  展区中文名
 * @param tags       标签（frontmatter tags 或展区别名）
 */
public record KnowledgeChunk(
        String id,
        String title,
        String sourcePath,
        String text,
        String zone,
        String zoneTitle,
        List<String> tags) {
}
