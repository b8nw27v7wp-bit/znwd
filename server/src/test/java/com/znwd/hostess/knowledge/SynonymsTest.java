package com.znwd.hostess.knowledge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * 同义词表：内置默认、在线替换、文件覆盖、导出回读。
 *
 * <p>表是全局静态的，所以每个用例后都必须 resetDefaults——否则会污染同包里的检索测试
 * （测试之间通过静态状态互相影响，是这类"可热更新配置"最容易留下的坑）。
 */
class SynonymsTest {

    @AfterEach
    void restore() {
        Synonyms.resetDefaults();
    }

    @Test
    @DisplayName("内置表：默认来源是 builtin，且扩展词与旧实现一致")
    void defaults() {
        assertEquals("builtin", Synonyms.source());
        assertEquals(30, Synonyms.size());   // 2026-09-23 补「客户」「融资」两条后为 25

        Synonyms.Expansion expansion = Synonyms.expandQueryParts("叶片检测要停机吗？");
        // 「叶片」「检测」两组都会展开，原词不重复计入扩展词
        assertTrue(expansion.extras().contains("叶轮"), "应展开出「叶轮」");
        assertTrue(expansion.extras().contains("巡检"), "应展开出「巡检」");
        assertFalse(expansion.extras().contains("叶片"), "原查询里已有的词不该当扩展词");
    }

    @Test
    @DisplayName("替换后立即生效，resetDefaults 能退回内置表")
    void replaceTakesEffect() {
        Map<String, List<String>> table = new LinkedHashMap<>();
        table.put("巡检机器人", List.of("巡检机器人", "机器狗", "四足"));
        Synonyms.replace(table, "test");

        assertEquals(1, Synonyms.size());
        assertEquals("test", Synonyms.source());
        assertTrue(Synonyms.expandQueryParts("巡检机器人能爬坡吗").extras().contains("机器狗"));

        Synonyms.resetDefaults();
        assertEquals("builtin", Synonyms.source());
        assertEquals(30, Synonyms.size());
    }

    @Test
    @DisplayName("空表会被拒：没有同义词等于把检索能力悄悄砍掉一半")
    void emptyTableRejected() {
        assertThrows(IllegalArgumentException.class, () -> Synonyms.replace(Map.of(), "test"));
        assertThrows(IllegalArgumentException.class, () -> Synonyms.replace(null, "test"));
        assertEquals(30, Synonyms.size(), "被拒后表必须保持原样");
    }

    @Test
    @DisplayName("TSV 覆盖表能读进来（注释、中文逗号、重复词都要处理）")
    void loadFromFile(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("synonyms.tsv");
        Files.writeString(file, """
                # 主词\t备选词，逗号分隔
                光伏\t光伏，太阳能， 组件
                玻璃幕墙\t幕墙
                """, StandardCharsets.UTF_8);

        int loaded = Synonyms.loadFromFile(file);
        assertEquals(2, loaded);
        assertEquals(file.toString(), Synonyms.source());
        assertEquals(List.of("光伏", "太阳能", "组件"), Synonyms.asMap().get("光伏"), "中文逗号与空格要去掉");
        assertTrue(Synonyms.expandQueryParts("光伏清洗").extras().contains("太阳能"));
    }

    @Test
    @DisplayName("导出成 TSV 再读回来，表完全一致（管理接口落盘用的就是这条路）")
    void tsvRoundTrip(@TempDir Path dir) throws IOException {
        Map<String, List<String>> table = new LinkedHashMap<>();
        table.put("塔筒", List.of("塔筒", "塔架", "风机塔"));
        table.put("叶片", List.of("叶片", "风叶"));
        Synonyms.replace(table, "test");

        Path file = dir.resolve("out.tsv");
        Files.writeString(file, Synonyms.toTsv(), StandardCharsets.UTF_8);
        Synonyms.resetDefaults();
        assertEquals(30, Synonyms.size());

        assertEquals(2, Synonyms.loadFromFile(file));
        assertEquals(table, Synonyms.asMap());
    }

    @Test
    @DisplayName("覆盖表不存在时不动当前表（不该把在线改的表悄悄清掉）")
    void missingFileKeepsCurrent(@TempDir Path dir) throws IOException {
        Map<String, List<String>> table = Map.of("临时", List.of("临时", "测试"));
        Synonyms.replace(table, "api");
        assertEquals(0, Synonyms.loadFromFile(dir.resolve("nope.tsv")));
        assertEquals("api", Synonyms.source());
        assertEquals(1, Synonyms.size());
    }
}
