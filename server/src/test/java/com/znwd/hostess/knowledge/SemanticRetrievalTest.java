package com.znwd.hostess.knowledge;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.embedding.EmbeddingProvider;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 语义向量在检索里的职责边界。
 *
 * <p>这条边界是实测定下来的，不是设计洁癖：真 bge-m3 向量接上之后，让它参与普通查询的 RRF 融合，
 * 137 条计分用例的 top1 从 1.0 掉到 0.9854（doc-08 / probe-45「运维方案能自动生成吗」被话题相邻的
 * 「项目背景与需求」顶掉）。所以规则是：
 * <ul>
 *   <li>关键词路过闸门时，<b>语义向量不参与排序</b>（关键词路在这套语料上 137/137，没理由让它改答案）；</li>
 *   <li>只有关键词没过闸门、余弦又达标时，语义向量才接管排序（兜底）；</li>
 *   <li>语义向量<b>允许新增候选</b>：关键词没召回到、但余弦达标的块可以补进候选集（RRF 融合时按新候选
 *       入列，HybridRetriever 的 additionalCandidates 就是数它的），新候选同样要过 minVectorScore 这道
 *       闸门——补候选不等于放宽关键词闸门。</li>
 * </ul>
 */
class SemanticRetrievalTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void 关键词过闸门时语义向量不得改动排序() throws Exception {
        VectorStore store = store(new AdversarialEmbedder());
        HybridRetriever retriever = new HybridRetriever(store, 3.8, 0.5);
        retriever.replace(chunks());
        assertEquals(RetrievalMode.HYBRID, retriever.stats().mode(), "索引建好了就该上报 hybrid");

        // 余弦一律偏向 B（见 AdversarialEmbedder），但关键词路第一名是 A：结果必须还是 A
        RetrievalOutcome outcome = retriever.retrieveWithDiagnostics("光伏清洁", 4);
        assertEquals("A#0", outcome.hits().get(0).id(), "关键词答得对时，语义向量不该把它顶下去");
        assertEquals(RetrievalMode.KEYWORD, outcome.diagnostics().mode(),
                "这次排序完全由关键词路决定，上报就必须是 keyword");
        assertFalse(outcome.diagnostics().gated());
    }

    @Test
    void 关键词不过闸门而余弦达标时走兜底() throws Exception {
        VectorStore store = store(new AdversarialEmbedder());
        // 关键词阈值设到不可能达到：模拟「这句话词面完全对不上资料」但语义上确实在域
        HybridRetriever retriever = new HybridRetriever(store, 999, 0.5);
        retriever.replace(chunks());

        RetrievalOutcome outcome = retriever.retrieveWithDiagnostics("光伏清洁", 4);
        assertFalse(outcome.hits().isEmpty(), "余弦达标就该被兜底救回来，而不是拒答");
        assertEquals(RetrievalReason.VECTOR_HIT, outcome.diagnostics().reason());
        assertEquals(RetrievalMode.HYBRID, outcome.diagnostics().mode());
        for (HybridHit hit : outcome.hits()) {
            assertTrue(hit.id().equals("A#0") || hit.id().equals("B#0"), "兜底也不得把闸门之外的块带进来");
        }
    }

    @Test
    void 兜底阈值高于域外余弦时仍然拒答() throws Exception {
        VectorStore store = store(new AdversarialEmbedder());
        // 1.5 是任何余弦都达不到的值：等价于「关闭兜底」（当前生产就是这么定的，见
        // HybridRetriever.DEFAULT_MIN_VECTOR_SCORE 的注释）
        HybridRetriever retriever = new HybridRetriever(store, 999, 1.5);
        retriever.replace(chunks());

        RetrievalOutcome outcome = retriever.retrieveWithDiagnostics("光伏清洁", 4);
        assertTrue(outcome.hits().isEmpty(), "兜底关闭时，关键词不过闸门就该拒答");
        assertTrue(outcome.diagnostics().gated());
    }

    private static VectorStore store(EmbeddingProvider embedder) throws Exception {
        Path indexFile = Files.createTempDirectory("znwd-semantic").resolve("vectors." + embedder.name() + ".json");
        return new VectorStore(embedder, indexFile, MAPPER, 32);
    }

    private static List<KnowledgeChunk> chunks() {
        return List.of(
                new KnowledgeChunk("A#0", "光伏清洁机器人", "01/A.md", "两栖光伏清洁机器人用于组件清洗。",
                        "pv-clean", "光伏清洁", List.of("光伏", "清洁")),
                new KnowledgeChunk("B#0", "客户与收入", "03/B.md", "目前客户数量为 0，2025 预期收入 80 万元。",
                        "project", "项目与团队", List.of("客户", "收入")));
    }

    /**
     * 故意与关键词路唱反调的假 provider：查询期无论输入什么，都返回 B 的向量方向
     * （构建期按文本区分，A=[1,0]、B=[0,1]）。这样「余弦看好 B」与「关键词看好 A」形成对立，
     * 才能测出谁在决定排序。
     */
    private static final class AdversarialEmbedder implements EmbeddingProvider {

        @Override
        public String name() {
            return "adversarial";
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
        public List<float[]> embed(List<String> texts) {
            List<float[]> out = new ArrayList<>(texts.size());
            if (texts.size() == 1) {
                out.add(new float[] {0f, 1f});
                return out;
            }
            for (String text : texts) {
                out.add(text.contains("客户") ? new float[] {0f, 1f} : new float[] {1f, 0f});
            }
            return out;
        }
    }
}
