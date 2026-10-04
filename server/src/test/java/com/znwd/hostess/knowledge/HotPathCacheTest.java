package com.znwd.hostess.knowledge;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import com.fasterxml.jackson.databind.ObjectMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * P1-6 热路径缓存的验收：问答链路上每次都要跑的两步，绝不能随语料规模线性变贵。
 *
 * <ul>
 *   <li>{@code HybridRetriever.stats()}：问答前、QueryRewriter 每次改写、/api/health 每次轮询都调它，
 *       老实现每次都要把全语料拼串 + SHA（{@link KnowledgeLoader#fingerprint}）判「向量与关键词是否同代」；</li>
 *   <li>{@code Retriever.retrieve()}：每问至少一次，老实现对每个 chunk 现场 bigram 分词
 *       （{@link Retriever#docTokens}），正文越长越贵。</li>
 * </ul>
 *
 * <p>断言用**比值**而不是绝对毫秒：拿「一次全语料重算」当尺子，量「N 次热路径调用」，
 * 阈值卡在两者量级之间——机器快慢同时缩放两边，结论不随环境抖动。
 * 退化实现（每次重算）是 N 倍尺子，必然越线；缓存实现是零点几倍，必然在线内。
 * 两头都留了 4 倍以上余量（见各用例注释里的数字）。
 *
 * <p>为什么不用 mock/spy：指纹算在 {@code VecData.matches} → 静态
 * {@link KnowledgeLoader#fingerprint} 里，桩不进去；分词同理（包内静态方法）。
 */
class HotPathCacheTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * stats() 的开销必须与**一次**全语料指纹同量级，而不是「500 次 = 500 个指纹」。
     *
     * <p>前置断言 HYBRID 不是顺手写的：只有向量快照与关键词快照同代且对齐（
     * {@code isCurrent && vectorAligned}）时才上报 HYBRID——这恰好就是老实现每次都会
     * 进 {@code matches()} 重算指纹的条件。少了它，测试可能在「向量路压根没建起来」的
     * 空快照上永远变绿，什么都没测到。
     */
    @Test
    void stats热路径不重算全语料指纹_开销与单次指纹同量级(@TempDir Path dir) {
        List<KnowledgeChunk> chunks = corpus(1200, 400);
        VectorStore store = new VectorStore(new FixedEmbedder(), dir.resolve("vectors.json"), MAPPER);
        HybridRetriever retriever = new HybridRetriever(store, 3.8, 0.35);
        retriever.replace(chunks);

        HybridStats stats = retriever.stats();
        assertEquals(RetrievalMode.HYBRID, stats.mode(),
                "前置：向量快照与关键词快照同代对齐（否则老实现短路，测试测不到指纹重算）");
        assertEquals(chunks.size(), stats.vector().vectors());
        assertNotEquals("", stats.vector().fingerprint());

        // 预热 JIT，之后每项取 3 轮里的最好成绩：比的是量级，不给调度抖动留把柄
        KnowledgeLoader.fingerprint(chunks);
        for (int i = 0; i < 300; i++) {
            retriever.stats();
        }

        long fingerprintNanos = bestOf(3, () -> KnowledgeLoader.fingerprint(chunks));
        long statsNanos = bestOf(3, () -> {
            for (int i = 0; i < 500; i++) {
                retriever.stats();
            }
        });

        // 退化实现：500 次 stats ≈ 500 个指纹，远超 10 倍阈值；缓存实现 ≈ 毫秒以下
        assertTrue(statsNanos < fingerprintNanos * 10,
                "stats() ×500 = " + statsNanos + "ns，一次全语料指纹 = " + fingerprintNanos
                        + "ns（阈值 " + (fingerprintNanos * 10) + "ns）："
                        + "stats 是问答/改写/健康的热路径，不得每次重算指纹");
    }

    /**
     * 检索的开销必须低于「建索引期给全语料分一遍词」的预算，而不是每问重付一次。
     *
     * <p>尺子取 {@code docTokens(chunk.text())} 对全语料跑一遍——这正是老实现
     * 每个查询对每个 chunk 干的事。阈值 5 倍：退化实现 20 次检索 ≈ 20 倍尺子（越线 4 倍），
     * 缓存实现只做查表与打分（正文分词只发生在建索引期），实测约 0.02 倍尺子（在线内 10 倍以上）。
     */
    @Test
    void 检索不再每查现场分词_开销低于建索引期全语料分词预算() {
        List<KnowledgeChunk> chunks = corpus(400, 3000);
        Retriever retriever = new Retriever();
        retriever.replace(chunks, Synonyms.snapshot());
        String query = "光伏组件怎么清洗维护";

        retriever.retrieve(query, 10); // 预热
        for (KnowledgeChunk chunk : chunks) {
            Retriever.docTokens(chunk.text());
        }

        long tokenizeNanos = bestOf(3, () -> {
            for (KnowledgeChunk chunk : chunks) {
                Retriever.docTokens(chunk.text());
            }
        });
        long retrieveNanos = bestOf(3, () -> {
            for (int i = 0; i < 20; i++) {
                retriever.retrieve(query, 10);
            }
        });

        assertTrue(retrieveNanos < tokenizeNanos * 5,
                "检索 ×20 = " + retrieveNanos + "ns，全语料现场分词一遍 = " + tokenizeNanos
                        + "ns（阈值 " + (tokenizeNanos * 5) + "ns）："
                        + "正文分词要缓存在索引快照里，检索期只读不算");
    }

    // ── helpers ──────────────────────────────────────────────────

    /** 合成语料：正文按给定长度灌满（分词开销与正文长度成正比，尺子靠它拉开量级） */
    private static List<KnowledgeChunk> corpus(int count, int bodyChars) {
        String unit = "光伏组件巡检与清洗流程：机器人沿阵列往复作业，记录污渍与热斑位置并回传数据。";
        StringBuilder pad = new StringBuilder(unit);
        while (pad.length() < bodyChars) {
            pad.append(unit);
        }
        List<KnowledgeChunk> chunks = new ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            chunks.add(new KnowledgeChunk(
                    "doc-" + i + ".md#0", "展品说明" + i, "doc-" + i + ".md",
                    "第" + i + "段 " + pad, "展区" + (i % 7), "展区", List.of("光伏", "清洁")));
        }
        return chunks;
    }

    private static long bestOf(int rounds, Runnable work) {
        long best = Long.MAX_VALUE;
        for (int round = 0; round < rounds; round++) {
            long start = System.nanoTime();
            work.run();
            best = Math.min(best, System.nanoTime() - start);
        }
        return best;
    }

    /** 语义向量假 provider（同 RagBackendSnapshotTest 的用途）：恒定单位向量，semantic=true */
    private static final class FixedEmbedder implements com.znwd.hostess.embedding.EmbeddingProvider {

        @Override
        public String name() {
            return "fixed";
        }

        @Override
        public int dims() {
            return 2;
        }

        @Override
        public boolean semantic() {
            return true;
        }

        @Override
        public String model() {
            return "fixed-model";
        }

        @Override
        public String endpoint() {
            return "local";
        }

        @Override
        public List<float[]> embed(List<String> texts) {
            List<float[]> out = new ArrayList<>(texts.size());
            for (int i = 0; i < texts.size(); i++) {
                out.add(new float[] {1f, 0f});
            }
            return out;
        }
    }
}
