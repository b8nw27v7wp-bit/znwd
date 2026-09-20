package com.znwd.hostess.knowledge;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.embedding.EmbeddingProvider;
import com.znwd.hostess.embedding.Vectors;

/**
 * 本地 JSON 向量索引。
 *
 * <p>三层防护，都是踩过的坑：
 * <ul>
 *   <li>构建/加载先写临时结构，成功后整包原子替换（检索端拿到的永远是一代完整数据）；</li>
 *   <li>内容指纹不一致就重建——只比对 chunk id 会让「知识正文改了但条数没变」继续用旧向量；</li>
 *   <li>非语义 provider（bag）的向量不参与融合与闸门兜底，由 {@link #semantic()} 上报。</li>
 * </ul>
 * 索引文件格式与旧 Node 版一致（version/provider/dims/fingerprint/updatedAt/items），可直接沿用。
 */
public class VectorStore {

    private static final int INDEX_VERSION = 1;
    private static final int BATCH = 32;

    private final EmbeddingProvider embedder;
    private final Path indexFile;
    private final ObjectMapper mapper;
    private final AtomicReference<VecData> data = new AtomicReference<>(VecData.empty());

    public VectorStore(EmbeddingProvider embedder, Path indexFile, ObjectMapper mapper) {
        this.embedder = embedder;
        this.indexFile = indexFile;
        this.mapper = mapper;
    }

    /** 供检索端固定引用，避免一次检索里混用新旧代 */
    public VecData snapshot() {
        return data.get();
    }

    public boolean semantic() {
        return embedder.semantic();
    }

    public void build(List<KnowledgeChunk> chunks) {
        Map<String, float[]> nextVectors = new LinkedHashMap<>();
        Map<String, KnowledgeChunk> nextById = new LinkedHashMap<>();
        String fingerprint = KnowledgeLoader.fingerprint(chunks);
        int dims = 0;
        for (int i = 0; i < chunks.size(); i += BATCH) {
            List<KnowledgeChunk> batch = chunks.subList(i, Math.min(chunks.size(), i + BATCH));
            List<String> texts = new ArrayList<>(batch.size());
            for (KnowledgeChunk c : batch) {
                texts.add(embedText(c));
            }
            List<float[]> vecs = embedder.embed(texts);
            for (int j = 0; j < batch.size(); j++) {
                KnowledgeChunk c = batch.get(j);
                float[] v = j < vecs.size() ? vecs.get(j) : new float[0];
                nextById.put(c.id(), c);
                nextVectors.put(c.id(), v);
                if (v.length > 0) {
                    dims = v.length;
                }
            }
        }
        persist(chunks, nextVectors, dims, fingerprint);
        data.set(new VecData(nextVectors, nextById, embedder.name(), dims, fingerprint));
    }

    public boolean tryLoad(List<KnowledgeChunk> chunks) {
        String fp = KnowledgeLoader.fingerprint(chunks);
        try {
            if (!Files.isRegularFile(indexFile)) {
                return false;
            }
            IndexFile parsed = mapper.readValue(Files.readString(indexFile, StandardCharsets.UTF_8), IndexFile.class);
            if (parsed.version() != INDEX_VERSION
                    || !embedder.name().equals(parsed.provider())
                    || parsed.items() == null
                    || !fp.equals(parsed.fingerprint())) {
                return false;
            }
            Map<String, KnowledgeChunk> nextById = new LinkedHashMap<>();
            for (KnowledgeChunk c : chunks) {
                nextById.put(c.id(), c);
            }
            Map<String, float[]> nextVectors = new LinkedHashMap<>();
            int dims = 0;
            int ok = 0;
            for (IndexItem item : parsed.items()) {
                if (item.id() != null && nextById.containsKey(item.id())
                        && item.vector() != null && !item.vector().isEmpty()) {
                    float[] vec = new float[item.vector().size()];
                    for (int i = 0; i < vec.length; i++) {
                        vec[i] = item.vector().get(i).floatValue();
                    }
                    nextVectors.put(item.id(), vec);
                    dims = vec.length;
                    ok++;
                }
            }
            if (ok > 0 && ok == chunks.size()) {
                data.set(new VecData(nextVectors, nextById, embedder.name(), dims, fp));
                return true;
            }
            return false;
        } catch (IOException | RuntimeException e) {
            // 索引损坏不影响服务：退化为重建
            return false;
        }
    }

    public List<VectorHit> search(String query, int topK) {
        return searchOn(snapshot(), query, topK);
    }

    /** 在固定 data 引用上检索（generation 安全） */
    public List<VectorHit> searchOn(VecData data, String query, int topK) {
        if (data.vectors().isEmpty()) {
            return List.of();
        }
        List<float[]> embedded = embedder.embed(List.of(query));
        if (embedded.isEmpty() || embedded.get(0).length == 0) {
            return List.of();
        }
        float[] q = embedded.get(0);
        List<VectorHit> hits = new ArrayList<>(data.vectors().size());
        for (Map.Entry<String, float[]> entry : data.vectors().entrySet()) {
            KnowledgeChunk chunk = data.byId().get(entry.getKey());
            if (chunk == null) {
                continue;
            }
            hits.add(new VectorHit(entry.getKey(), Vectors.cosine(q, entry.getValue()), chunk));
        }
        hits.sort(Comparator.comparingDouble(VectorHit::score).reversed());
        return hits.size() <= topK ? hits : new ArrayList<>(hits.subList(0, topK));
    }

    public VectorStats stats() {
        VecData d = data.get();
        return new VectorStats(
                d.providerName().isEmpty() ? embedder.name() : d.providerName(),
                embedder.semantic(),
                d.dims(),
                d.vectors().size(),
                d.fingerprint(),
                indexFile.toString());
    }

    private String embedText(KnowledgeChunk chunk) {
        return chunk.title() + "\n" + (chunk.zoneTitle() == null ? "" : chunk.zoneTitle()) + "\n"
                + String.join(" ", chunk.tags()) + "\n" + chunk.text();
    }

    private void persist(List<KnowledgeChunk> chunks, Map<String, float[]> vectors, int dims, String fingerprint) {
        List<IndexItem> items = new ArrayList<>(chunks.size());
        for (KnowledgeChunk c : chunks) {
            float[] vec = vectors.getOrDefault(c.id(), new float[0]);
            items.add(new IndexItem(c.id(), Vectors.toList(vec)));
        }
        IndexFile payload = new IndexFile(INDEX_VERSION, embedder.name(), dims, fingerprint,
                java.time.Instant.now().toString(), items);
        try {
            if (indexFile.getParent() != null) {
                Files.createDirectories(indexFile.getParent());
            }
            Path tmp = indexFile.resolveSibling(indexFile.getFileName() + "." + ProcessHandle.current().pid() + ".tmp");
            Files.writeString(tmp, mapper.writeValueAsString(payload), StandardCharsets.UTF_8);
            try {
                Files.move(tmp, indexFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException atomicUnsupported) {
                Files.move(tmp, indexFile, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException e) {
            throw new IllegalStateException("写入向量索引失败：" + indexFile, e);
        }
    }

    /** 一代向量数据（不可变） */
    public record VecData(
            Map<String, float[]> vectors,
            Map<String, KnowledgeChunk> byId,
            String providerName,
            int dims,
            String fingerprint) {

        public static VecData empty() {
            return new VecData(new HashMap<>(), new HashMap<>(), "", 0, "");
        }
    }

    @JsonPropertyOrder({"version", "provider", "dims", "fingerprint", "updatedAt", "items"})
    public record IndexFile(int version, String provider, int dims, String fingerprint, String updatedAt,
                            List<IndexItem> items) {
    }

    public record IndexItem(String id, List<Float> vector) {
    }
}
