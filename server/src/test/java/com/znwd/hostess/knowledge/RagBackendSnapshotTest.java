package com.znwd.hostess.knowledge;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.config.KnowledgeService;
import com.znwd.hostess.embedding.BagEmbeddingProvider;
import com.znwd.hostess.embedding.EmbeddingProvider;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RagBackendSnapshotTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @AfterEach
    void resetSynonyms() {
        Synonyms.resetDefaults();
    }

    @Test
    void 模型端点或完整输入变化时不能复用旧索引(@TempDir Path dir) {
        Path indexFile = dir.resolve("vectors.json");
        List<KnowledgeChunk> chunks = List.of(chunk("z", "展区甲", List.of("标签甲"), "正文内容"));
        VectorStore first = new VectorStore(new FixedEmbedder("model-a", "https://embed-a", 2), indexFile, MAPPER);
        first.build(chunks);

        VectorStore modelChanged = new VectorStore(
                new FixedEmbedder("model-b", "https://embed-a", 2), indexFile, MAPPER);
        assertFalse(modelChanged.tryLoad(chunks), "同名 provider 换模型必须重建");

        VectorStore endpointChanged = new VectorStore(
                new FixedEmbedder("model-a", "https://embed-b", 2), indexFile, MAPPER);
        assertFalse(endpointChanged.tryLoad(chunks), "端点身份变化必须重建");

        List<KnowledgeChunk> changedInput = List.of(chunk("z", "展区乙", List.of("标签乙"), "正文内容"));
        VectorStore inputChanged = new VectorStore(
                new FixedEmbedder("model-a", "https://embed-a", 2), indexFile, MAPPER);
        assertFalse(inputChanged.tryLoad(changedInput), "展区标题或标签变化必须重建");
    }

    @Test
    void 非有限值和维度不一致不会发布向量(@TempDir Path dir) {
        VectorStore nonFinite = new VectorStore(new FixedEmbedder("m", "local", 2,
                new float[] {Float.NaN, 0f}), dir.resolve("non-finite.json"), MAPPER);
        nonFinite.build(List.of(chunk("a", "展区", List.of(), "正文")));
        assertEquals(0, nonFinite.stats().vectors());
        assertNotNull(nonFinite.degradedReason());

        VectorStore wrongDims = new VectorStore(new FixedEmbedder("m", "local", 2,
                new float[] {1f}), dir.resolve("wrong-dims.json"), MAPPER);
        wrongDims.build(List.of(chunk("a", "展区", List.of(), "正文")));
        assertEquals(0, wrongDims.stats().vectors());
        assertTrue(wrongDims.degradedReason().contains("维度"));
    }

    @Test
    void 零词面语义命中必须返回向量命中而不是空结果() throws Exception {
        VectorStore store = new VectorStore(new FixedEmbedder("m", "local", 2),
                Files.createTempDirectory("znwd-zero-lexical").resolve("vectors.json"), MAPPER);
        HybridRetriever retriever = new HybridRetriever(store, 999, 0.5);
        retriever.replace(List.of(chunk("a", "展区", List.of("标签"), "无人机巡检流程")));

        RetrievalOutcome outcome = retriever.retrieveWithDiagnostics("完全不相干的问法", 4);
        assertTrue(retriever.retrieveKeyword("完全不相干的问法", 4).isEmpty());
        assertFalse(outcome.hits().isEmpty());
        assertEquals(RetrievalReason.VECTOR_HIT, outcome.diagnostics().reason());
        assertEquals(RetrievalMode.HYBRID, outcome.diagnostics().mode());
    }

    @Test
    void reload只发布完整新代且空库不会覆盖旧快照(@TempDir Path dir) throws Exception {
        VectorStore store = new VectorStore(new FixedEmbedder("m", "local", 2),
                dir.resolve("vectors.json"), MAPPER);
        HybridRetriever retriever = new HybridRetriever(store, 999, 0.5);
        List<KnowledgeChunk> oldChunks = List.of(chunk("old", "旧展区", List.of("旧标签"), "旧正文"));
        List<KnowledgeChunk> newChunks = List.of(chunk("new", "新展区", List.of("新标签"), "新正文"));
        retriever.replace(oldChunks);
        long generation = retriever.generation();
        VectorStore.VecData oldVectorSnapshot = store.snapshot();

        retriever.replace(newChunks);
        assertEquals(generation + 1, retriever.generation());
        assertNotEquals(oldVectorSnapshot, store.snapshot());
        assertTrue(store.snapshot().matches(newChunks));
        assertEquals(List.of("new"), retriever.list().stream().map(KnowledgeChunk::id).toList());
        assertTrue(retriever.retrieve("新正文", 4).stream().anyMatch(hit -> hit.id().equals("new")));

        assertThrows(IllegalArgumentException.class, () -> retriever.replace(List.of()));
        assertEquals(generation + 1, retriever.generation());
        assertEquals(List.of("new"), retriever.list().stream().map(KnowledgeChunk::id).toList());
    }

    @Test
    void 不存在或空知识目录加载失败且服务保留上一代(@TempDir Path dir) throws Exception {
        KnowledgeLoader loader = new KnowledgeLoader(MAPPER);
        assertThrows(KnowledgeLoader.KnowledgeLoadException.class, () -> loader.load(dir.resolve("missing")));

        Path empty = Files.createDirectory(dir.resolve("empty"));
        assertThrows(KnowledgeLoader.KnowledgeLoadException.class, () -> loader.load(empty));

        Path valid = Files.createDirectory(dir.resolve("valid"));
        Files.writeString(valid.resolve("a.md"), "# 标题\n\n这是知识正文。", StandardCharsets.UTF_8);
        VectorStore store = new VectorStore(new BagEmbeddingProvider(8), dir.resolve("service-vectors.json"), MAPPER);
        HybridRetriever retriever = new HybridRetriever(store, 0.1, 0.5);
        KnowledgeService service = new KnowledgeService(loader, retriever, store, valid, false);
        service.loadInitial();
        int oldSize = service.chunks().size();
        AtomicInteger callbacks = new AtomicInteger();
        service.setOnReloaded(callbacks::incrementAndGet);
        Files.delete(valid.resolve("a.md"));

        assertThrows(KnowledgeLoader.KnowledgeLoadException.class, service::reload);
        assertEquals(oldSize, service.chunks().size());
        assertEquals(0, callbacks.get());
    }

    private static KnowledgeChunk chunk(String id, String zoneTitle, List<String> tags, String text) {
        return new KnowledgeChunk(id, "标题", id + ".md", text, "zone", zoneTitle, tags);
    }

    private static final class FixedEmbedder implements EmbeddingProvider {
        private final String model;
        private final String endpoint;
        private final int dims;
        private final float[] vector;

        private FixedEmbedder(String model, String endpoint, int dims) {
            this(model, endpoint, dims, new float[] {1f, 0f});
        }

        private FixedEmbedder(String model, String endpoint, int dims, float[] vector) {
            this.model = model;
            this.endpoint = endpoint;
            this.dims = dims;
            this.vector = vector.clone();
        }

        @Override
        public String name() {
            return "fixed";
        }

        @Override
        public int dims() {
            return dims;
        }

        @Override
        public boolean semantic() {
            return true;
        }

        @Override
        public String model() {
            return model;
        }

        @Override
        public String endpoint() {
            return endpoint;
        }

        @Override
        public List<float[]> embed(List<String> texts) {
            List<float[]> result = new ArrayList<>();
            for (int i = 0; i < texts.size(); i++) {
                result.add(vector.clone());
            }
            return result;
        }
    }
}
