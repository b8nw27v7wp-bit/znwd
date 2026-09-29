package com.znwd.hostess.rag;

import java.util.List;

import org.junit.jupiter.api.Test;

import com.znwd.hostess.knowledge.HybridHit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 来源面板的入选规则。
 *
 * <p>这条规则来自一次实测：问「多久能回本」，回答由 `常见问题.md`（关键词 8.44）支撑，
 * 但 topK 的尾部挂着两条关键词 3.89 的无关资料，参观者在来源面板里看到的是三张卡片。
 * 融合分（RRF）在相邻名次间没有区分度，所以门槛必须落在关键词分上。
 */
class RagPipelineTest {

    private static HybridHit hit(String path, double keywordScore) {
        return hit(path, keywordScore, "片段正文");
    }

    private static HybridHit hit(String path, double keywordScore, String text) {
        return new HybridHit(path + "#0", "标题", path, text, "pv-clean", "光伏清洁机器人",
                List.of("光伏"), 0.0164, keywordScore, 0.0, 3, List.of("光伏"), 0.0164);
    }

    @Test
    void 与最高分同量级的块保留_低量级块不进来源面板() {
        List<RagSource> sources = RagPipeline.toSources(List.of(
                hit("03_项目与团队/常见问题.md", 8.44),
                hit("02_光伏医生运维系统/巡检与缺陷诊断.md", 3.89),
                hit("02_光伏医生运维系统/常见问题.md", 3.89)));

        assertEquals(1, sources.size(), "只有支撑回答的那条该进来源面板");
        assertEquals("03_项目与团队/常见问题.md", sources.get(0).sourcePath());
    }

    @Test
    void 同一份资料的多个片段只占一条来源() {
        List<RagSource> sources = RagPipeline.toSources(List.of(
                hit("03_项目与团队/商业模式与定价.md", 9.86),
                hit("03_项目与团队/商业模式与定价.md", 9.50),
                hit("03_项目与团队/服务与合作.md", 9.25)));

        assertEquals(2, sources.size());
        assertEquals(List.of("03_项目与团队/商业模式与定价.md", "03_项目与团队/服务与合作.md"),
                sources.stream().map(RagSource::sourcePath).toList());
    }

    @Test
    void 门槛是相对最高分的一半_恰好等于门槛的保留() {
        // 最高 8.0 → 门槛 4.0；4.0 保留（判据是「低于」才剔除），3.99 剔除
        List<RagSource> sources = RagPipeline.toSources(List.of(
                hit("a.md", 8.0),
                hit("b.md", 4.0),
                hit("c.md", 3.99)));

        assertEquals(List.of("a.md", "b.md"), sources.stream().map(RagSource::sourcePath).toList());
    }

    @Test
    void 关键词分全为零时不过滤_保持原行为() {
        // 理论上不该出现（闸门已经拦了），但真出现时不能把来源面板清空
        List<RagSource> sources = RagPipeline.toSources(List.of(hit("a.md", 0), hit("b.md", 0)));
        assertEquals(2, sources.size());
    }

    @Test
    void 空输入返回空列表() {
        assertTrue(RagPipeline.toSources(List.of()).isEmpty());
    }

    @Test
    void 片段截断到200字_融合分与关键词分如实带出() {
        String longText = "光".repeat(300);
        RagSource source = RagPipeline.toSources(List.of(hit("a.md", 12.5, longText))).get(0);

        assertEquals(200, source.snippet().length());
        assertEquals(12.5, source.keywordScore(), 1e-9);
        assertEquals(0.0164, source.score(), 1e-9);
    }

    // —— sources 增强：分块原文 + 命中位置（纯增量字段，入选与去重规则见上面的用例）——

    @Test
    void 来源携带完整分块原文_超过上限截断() {
        String text = "光".repeat(900);
        RagSource source = RagPipeline.toSources(List.of(hit("a.md", 10.0, text))).get(0);

        assertEquals(RagPipeline.CHUNK_TEXT_MAX, source.chunkText().length());
        assertEquals(text.substring(0, RagPipeline.CHUNK_TEXT_MAX), source.chunkText());
        assertEquals(200, source.snippet().length(), "snippet 仍是列表用的前 200 字，现状不变");
        assertEquals(-1, source.matchOffset(), "命中词不在正文里（helper 的「光伏」没写进文本）→ 不定位");
    }

    @Test
    void 定位首个命中词在分块中的偏移() {
        String text = "两栖机器人在水面行进。光伏组件的积灰由滚刷清除，光伏板边缘二次清洗。";
        RagSource source = RagPipeline.toSources(List.of(hitWithMatch(text, List.of("光伏", "积灰")))).get(0);

        assertEquals(text, source.chunkText(), "500 字级的分块不截断，原文整块带给前端");
        assertEquals("光伏", source.matchTerm());
        assertEquals(text.indexOf("光伏"), source.matchOffset(), "偏移按原文字符算，前端可直接 substring 高亮");
    }

    @Test
    void 只在标题里命中的词不拿来定位_落到正文里出现的词() {
        String text = "正文只提到了巡检流程。";
        RagSource source = RagPipeline.toSources(
                List.of(hitWithMatch(text, List.of("标题独有词", "巡检")))).get(0);

        assertEquals("巡检", source.matchTerm());
        assertEquals(text.indexOf("巡检"), source.matchOffset());
    }

    @Test
    void 一个词都定位不到时matchTerm为空_偏移为负一() {
        RagSource source = RagPipeline.toSources(
                List.of(hitWithMatch("正文里没有命中词。", List.of("标题独有词")))).get(0);

        assertNull(source.matchTerm());
        assertEquals(-1, source.matchOffset());
    }

    @Test
    void matched为空或缺失时照样返回来源() {
        RagSource empty = RagPipeline.toSources(List.of(hitWithMatch("正文", List.of()))).get(0);
        RagSource missing = RagPipeline.toSources(List.of(hitWithMatch("正文", null))).get(0);

        assertEquals("正文", empty.chunkText());
        assertEquals(-1, empty.matchOffset());
        assertNull(missing.matchTerm());
        assertEquals(-1, missing.matchOffset());
    }

    @Test
    void 拉丁命中词忽略大小写定位_偏移仍按原文() {
        String text = "系统支持 PV 组件的自动清洗。";
        RagSource source = RagPipeline.toSources(List.of(hitWithMatch(text, List.of("pv")))).get(0);

        assertEquals("pv", source.matchTerm());
        assertEquals(text.indexOf("PV"), source.matchOffset());
    }

    private static HybridHit hitWithMatch(String text, List<String> matched) {
        return new HybridHit("a#0", "标题", "a.md", text, "pv-clean", "光伏清洁机器人",
                List.of("光伏"), 0.0164, 12.5, 0.0, matched == null ? 0 : matched.size(), matched, 0.0164);
    }
}
