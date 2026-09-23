package com.znwd.hostess.knowledge;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.embedding.EmbeddingProvider;
import com.znwd.hostess.embedding.EmbeddingException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 语义路走外部服务（云端 embedding）之后的降级行为。
 *
 * <p>关键约定：embedding 不通<b>不能让展板跟着不可用</b>。关键词路本来就能独立支撑
 * （真实语料 137/137 全靠它），所以构建失败要退化为仅关键词并在 health 上报原因，
 * 查询期失败要只影响本次检索并计数——两条都不能把异常抛给访客。
 *
 * <p>这里用假 provider 而不是打真实接口：降级行为的测试不该依赖外部服务是否可达。
 */
class EmbeddingFallbackTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void 向量构建失败时退回仅关键词且不抛出异常() throws Exception {
        List<KnowledgeChunk> chunks = fixtureChunks();
        VectorStore store = newStore(new AlwaysFailEmbedder(), "build-fail");
        HybridRetriever retriever = new HybridRetriever(store, 3.8, 0.35);

        retriever.replace(chunks); // 不得抛出：现场没人能修「embedding 抖一下服务就起不来」

        HybridStats stats = retriever.stats();
        assertEquals(RetrievalMode.KEYWORD, stats.mode(), "语义路不可用时只能上报 keyword，不能是 hybrid");
        assertFalse(stats.semantic(), "语义路当下不可用，semantic 必须是 false");
        assertNotNull(stats.degradedReason(), "必须给出降级原因，否则现场只能靠猜");
        assertTrue(stats.degradedReason().contains("构建失败"), "降级原因=" + stats.degradedReason());
        assertEquals(0, stats.vector().vectors(), "降级时不保留旧向量，避免两代数据混用");

        // 关键词路照常工作：在域问题仍命中，域外问题仍被闸门拦下
        RetrievalOutcome inDomain = retriever.retrieveWithDiagnostics("光伏清洁无人机", 4);
        assertFalse(inDomain.hits().isEmpty(), "降级后关键词路必须仍然命中");
        assertFalse(inDomain.diagnostics().gated());
        assertTrue(retriever.retrieveWithDiagnostics("帮我写一首诗", 4).hits().isEmpty(), "闸门行为不受降级影响");
    }

    @Test
    void 查询期失败时如实上报并在下次成功后自愈() throws Exception {
        QueryFailingEmbedder embedder = new QueryFailingEmbedder();
        VectorStore store = newStore(embedder, "query-fail");
        HybridRetriever retriever = new HybridRetriever(store, 3.8, 0.35);
        retriever.replace(fixtureChunks());

        assertEquals(RetrievalMode.HYBRID, retriever.stats().mode(), "索引建好了就该上报 hybrid");
        assertEquals(0, store.queryFailures());

        embedder.failQueries = true;
        RetrievalOutcome outcome = retriever.retrieveWithDiagnostics("光伏清洁无人机", 4);

        assertFalse(outcome.hits().isEmpty(), "查询期向量化失败不得让整次检索失败");
        assertEquals(1, store.queryFailures(), "失败次数必须被计数（否则语义路静悄悄失效没人知道）");
        assertTrue(store.lastQueryError() != null && store.lastQueryError().contains("查询期"),
                "最近一次错误=" + store.lastQueryError());
        assertFalse(retriever.stats().semantic(),
                "索引在、但每次查询都在失败时，语义路实际没在做事，health 不能还报可用");
        assertTrue(retriever.stats().degradedReason().contains("查询期"),
                "降级原因=" + retriever.stats().degradedReason());

        // 外部服务恢复后不该一直挂着降级标记：下一次成功就自愈
        embedder.failQueries = false;
        retriever.retrieveWithDiagnostics("光伏清洁无人机", 4);
        assertTrue(retriever.stats().semantic(), "查询成功一次就该自愈，不然降级标记会永远挂着");
        assertNull(retriever.stats().degradedReason());
    }

    @Test
    void 批次大小按配置切分_云端各有上限() throws Exception {
        RecordingEmbedder embedder = new RecordingEmbedder();
        List<KnowledgeChunk> chunks = new ArrayList<>();
        for (int i = 0; i < 20; i++) {
            chunks.add(new KnowledgeChunk("f#%d".formatted(i), "标题" + i, "f.md", "正文" + i, "z", "展区", List.of()));
        }
        VectorStore store = newStore(embedder, "batch", 7);

        store.build(chunks);

        assertEquals(List.of(7, 7, 6), embedder.batchSizes, "必须按 EMBED_BATCH_SIZE 切分：超上限的请求会被整个拒绝");
        assertEquals(20, store.stats().vectors());
    }

    private static VectorStore newStore(EmbeddingProvider embedder, String tag) throws Exception {
        return newStore(embedder, tag, 32);
    }

    private static VectorStore newStore(EmbeddingProvider embedder, String tag, int batchSize) throws Exception {
        // 每个用例一个临时索引文件：残留文件会让 tryLoad 命中上一轮数据，测试就成了看运气
        Path indexFile = Files.createTempDirectory("znwd-embed-" + tag).resolve("vectors." + embedder.name() + ".json");
        return new VectorStore(embedder, indexFile, MAPPER, batchSize);
    }

    private static List<KnowledgeChunk> fixtureChunks() {
        return List.of(
                new KnowledgeChunk("01_光伏清洁机器人/产品概述.md#0", "光伏清洁机器人",
                        "01_光伏清洁机器人/产品概述.md",
                        "两栖光伏清洁机器人用于光伏组件清洗，可替代人工。", "pv-clean", "光伏清洁", List.of("光伏", "清洁")),
                new KnowledgeChunk("02_光伏医生运维系统/系统总览.md#0", "光伏医生运维系统",
                        "02_光伏医生运维系统/系统总览.md",
                        "光伏医生用无人机巡检并诊断组件缺陷，形成运维闭环。", "pv-doctor", "光伏医生", List.of("巡检", "诊断")));
    }

    /** 任何一次向量化都失败：模拟 EMBED_BASE_URL 不通 / key 失效 / 额度用尽 */
    private static final class AlwaysFailEmbedder implements EmbeddingProvider {

        @Override
        public String name() {
            return "always_fail";
        }

        @Override
        public int dims() {
            return 8;
        }

        @Override
        public boolean semantic() {
            return true;
        }

        @Override
        public List<float[]> embed(List<String> texts) {
            throw new EmbeddingException("Embeddings HTTP 401: {\"message\":\"Invalid token\"}");
        }
    }

    /** 构建期正常、查询期（单条输入）失败：模拟外部服务在运行中途挂掉 */
    private static final class QueryFailingEmbedder implements EmbeddingProvider {

        private volatile boolean failQueries;

        @Override
        public String name() {
            return "query_fail";
        }

        @Override
        public int dims() {
            return 8;
        }

        @Override
        public boolean semantic() {
            return true;
        }

        @Override
        public List<float[]> embed(List<String> texts) {
            if (failQueries && texts.size() == 1) {
                throw new EmbeddingException("Embeddings failed: 查询期连接超时");
            }
            List<float[]> out = new ArrayList<>(texts.size());
            for (String text : texts) {
                float[] vec = new float[8];
                for (int i = 0; i < vec.length; i++) {
                    vec[i] = (text.length() + i) % 5;
                }
                out.add(vec);
            }
            return out;
        }
    }

    /** 记录每次请求的条数：验证批次切分 */
    private static final class RecordingEmbedder implements EmbeddingProvider {
        private final List<Integer> batchSizes = new ArrayList<>();

        @Override
        public String name() {
            return "recording";
        }

        @Override
        public int dims() {
            return 4;
        }

        @Override
        public boolean semantic() {
            return true;
        }

        @Override
        public List<float[]> embed(List<String> texts) {
            batchSizes.add(texts.size());
            List<float[]> out = new ArrayList<>(texts.size());
            for (int i = 0; i < texts.size(); i++) {
                out.add(new float[] {1f, 0f, 0f, 0f});
            }
            return out;
        }
    }
}
