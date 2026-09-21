package com.znwd.hostess.knowledge;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 分词边界的钉子测试。
 *
 * <p>这几条以前没有测试守着，结果两个 bug 同时存在了很久：bigram 跨标点连成链（「叶片检测？外观」→「测外」），
 * 以及同义词扩展把备选词拼成一个字符串再切（「组件 电站 清洗 积灰」→「件电」「灰清」）。两者都往查询里塞
 * 了不存在的词条，而这些词条带真实 IDF，直接把域外问题的分数抬过闸门阈值。
 */
class RetrieverTokensTest {

    @Test
    void 同义词扩展不产生跨备选词的垃圾bigram() {
        // 直接喂一组「会被拼在一起」的备选词：以前它们被 join 成一条串再切 bigram，
        // 于是「组件 电站 清洗 积灰」造出「件电」「灰清」这些不存在的词条参与打分。
        List<String> tokens = Retriever.queryTokens(String.join(" ", List.of("组件", "电站", "清洗", "积灰", "清洁")));
        assertTrue(tokens.contains("组件"), "备选词本身要保留");
        assertTrue(tokens.contains("清洗"));
        assertFalse(tokens.contains("件电"), "「组件」与「电站」之间不该连出 bigram");
        assertFalse(tokens.contains("灰清"), "「积灰」与「清洁」之间不该连出 bigram");
        assertFalse(tokens.contains("站清"), "「电站」与「清洗」之间不该连出 bigram");
    }

    @Test
    void 真实同义词表展开后同样不连词() {
        // 「报告」在同义词表里指向 检测报告/巡检报告/作业报告，这些是真实生效的扩展
        Synonyms.Expansion expansion = Synonyms.expandQueryParts("报告");
        assertTrue(expansion.extras().size() > 1, "报告 应有备选词: " + expansion.extras());
        List<String> tokens = Retriever.queryTokens(String.join(" ", expansion.extras()));
        assertFalse(tokens.contains("告检") || tokens.contains("告巡"), "备选词之间不该连词: " + tokens);
    }

    @Test
    void bigram不跨标点与空格边界() {
        List<String> tokens = Retriever.queryTokens("叶片检测？外观有裂纹");
        assertTrue(tokens.contains("叶片"));
        assertTrue(tokens.contains("裂纹"));
        assertFalse(tokens.contains("测外"), "标点两侧不该连出 bigram");
    }

    @Test
    void 文档侧同样不跨边界取bigram() {
        Map<String, Integer> freq = Retriever.docTokens("停机检测。不停机方案");
        assertTrue(freq.containsKey("停机"));
        assertTrue(freq.containsKey("方案"));
        assertFalse(freq.containsKey("测不") || freq.containsKey("测方"), "文档侧标点处不该连词");
    }

    @Test
    void 连续的词仍按bigram切出() {
        List<String> tokens = Retriever.queryTokens("光伏清洁");
        assertTrue(tokens.contains("光伏"));
        assertTrue(tokens.contains("伏清"));
        assertTrue(tokens.contains("清洁"));
    }
}
