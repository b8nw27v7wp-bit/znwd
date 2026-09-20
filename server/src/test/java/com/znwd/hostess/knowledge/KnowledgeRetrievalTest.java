package com.znwd.hostess.knowledge;

import java.nio.file.Path;
import java.util.List;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.embedding.BagEmbeddingProvider;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 检索内核测试：分块、关键词打分、闸门行为——这几处一改就会影响评测数字，必须有测试钉住。 */
class KnowledgeRetrievalTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void 标题感知分块_同一标题下的段落打包并保留标题上下文() {
        String text = """
                # 叶片检测
                无人机沿叶片表面飞行拍摄，不需要停机。

                检测完成后生成缺陷清单。
                """;
        List<String> chunks = TextChunker.chunkText(text);
        assertEquals(1, chunks.size(), "同一标题下的短段落应打包成一块");
        assertTrue(chunks.get(0).startsWith("叶片检测"));
        assertTrue(chunks.get(0).contains("不需要停机"));
    }

    @Test
    void 超长段落滑窗切分且带重叠() {
        String longParagraph = "叶片".repeat(400);
        List<String> chunks = TextChunker.chunkText(longParagraph, 500, 80);
        assertTrue(chunks.size() > 1);
        for (String chunk : chunks) {
            assertTrue(chunk.length() <= 500, "单块不得超过上限");
        }
    }

    @Test
    void 单字命中不再给分_域外问题无候选() {
        Retriever retriever = new Retriever();
        retriever.replace(List.of(new KnowledgeChunk("a#0", "参观须知", "90_通识/参观须知.md",
                "展厅内禁止触摸展品，拍照请关闭闪光灯。", "safety", "展厅须知", List.of("安全"))));

        assertTrue(retriever.retrieve("今天天气怎么样", 4).isEmpty(), "域外闲聊不该拿到分数");
        assertTrue(retriever.retrieve("什么意思", 4).isEmpty(), "单字命中不足以构成相关性");
        assertFalse(retriever.retrieve("可以触摸展品吗", 4).isEmpty(), "在域问题必须能命中");
    }

    @Test
    void 闸门在非语义向量下拦截域外问题且如实上报keyword() {
        HybridRetriever retriever = fixtureHybrid();
        RetrievalOutcome inDomain = retriever.retrieveWithDiagnostics("光伏清洁无人机", 4);
        assertEquals(RetrievalMode.KEYWORD, inDomain.diagnostics().mode(), "bag 非语义，不得上报 hybrid");
        assertFalse(inDomain.diagnostics().gated());
        assertTrue(inDomain.diagnostics().candidates() > 0, "在域问题必须找到候选");
        assertFalse(inDomain.hits().isEmpty(), "在域问题必须给出命中");

        RetrievalOutcome outOfDomain = retriever.retrieveWithDiagnostics("帮我写一首诗", 4);
        RetrievalDiagnostics diag = outOfDomain.diagnostics();
        assertTrue(outOfDomain.hits().isEmpty(), "域外问题必须被闸门拦下");
        assertTrue(diag.gated(), "闸门必须给出 gated=true");
        assertFalse(diag.semantic());
        assertTrue(diag.reason() == RetrievalReason.NO_CANDIDATES || diag.reason() == RetrievalReason.BELOW_THRESHOLD,
                "拦截原因必须是 no_candidates 或 below_threshold，实际=" + diag.reason()
                        + " best=" + diag.keywordBestScore() + " candidates=" + diag.candidates());
    }

    @Test
    void reload后索引代数递增且向量索引可复用() {
        HybridRetriever retriever = fixtureHybrid();
        long before = retriever.generation();
        retriever.replace(retriever.list());
        assertEquals(before + 1, retriever.generation());
        assertTrue(retriever.stats().indexReady());
    }

    /**
     * 用合成语料而不是真知识库：闸门行为要可复现，不受展厅资料改动影响。
     *
     * <p>合成语料的分数尺度和真实语料不是一回事，所以阈值用下面这个固定值：
     * 生产阈值（{@code HybridRetriever.DEFAULT_MIN_KEYWORD_SCORE}）会随语料重新标定而变化，
     * 让这个测试跟着它走，迟早会出现"改语料 → 闸门行为测试无辜变红"。
     */
    private static final double FIXTURE_MIN_KEYWORD_SCORE = 3.8;

    private static HybridRetriever fixtureHybrid() {
        List<KnowledgeChunk> chunks = List.of(
                new KnowledgeChunk("01_光伏清洁无人机/产品概述.md#0", "光伏清洁无人机",
                        "01_光伏清洁无人机/产品概述.md",
                        "光伏清洁无人机", "pv-clean", "光伏清洁", List.of("光伏", "清洁")),
                new KnowledgeChunk("02_叶片检测/检测流程.md#0", "叶片检测流程",
                        "02_叶片检测/检测流程.md",
                        "无人机沿叶片表面飞行拍摄，不需要停机即可完成叶片检测。", "blade", "叶片检测",
                        List.of("叶片", "检测")));
        BagEmbeddingProvider embedder = new BagEmbeddingProvider(512);
        Path indexFile = Path.of("target", "test-indexes", "vectors.bag.json");
        VectorStore store = new VectorStore(embedder, indexFile, MAPPER);
        HybridRetriever retriever = new HybridRetriever(store,
                FIXTURE_MIN_KEYWORD_SCORE, HybridRetriever.DEFAULT_MIN_VECTOR_SCORE);
        retriever.replace(chunks);
        return retriever;
    }
}
