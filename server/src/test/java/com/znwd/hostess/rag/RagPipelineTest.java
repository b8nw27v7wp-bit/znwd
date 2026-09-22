package com.znwd.hostess.rag;

import java.util.List;

import org.junit.jupiter.api.Test;

import com.znwd.hostess.knowledge.HybridHit;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
}
