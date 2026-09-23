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
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

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
 *
 * <p><b>语义路可降级</b>：provider 走的是外部服务（云端 embedding 或本机服务），它不通时
 * <b>不能让整个展板跟着不可用</b>——关键词路本来就能独立支撑（137/137 全靠它）。
 * 所以构建/查询失败一律记为降级原因并退回空向量，由 {@link #degradedReason()} 与
 * {@code /api/health} 显式上报，而不是抛出去把启动或请求带崩。
 */
public class VectorStore {

    private static final Logger log = LoggerFactory.getLogger(VectorStore.class);

    private static final int INDEX_VERSION = 1;

    /** provider 的单请求批次上限各不相同（本地 bge 可以大、云服务常见 10~32），由 EMBED_BATCH_SIZE 定 */
    private static final int DEFAULT_BATCH = 32;

    private final EmbeddingProvider embedder;
    private final Path indexFile;
    private final ObjectMapper mapper;
    private final int batchSize;
    private final AtomicReference<VecData> data = new AtomicReference<>(VecData.empty());

    /** 语义路不可用的原因（构建失败等）；null = 正常。语义路「能力」与「当下能不能用」是两件事，见 semantic() */
    private volatile String degradedReason;
    private final AtomicInteger queryFailures = new AtomicInteger();
    private volatile String lastQueryError;
    /** 查询期向量化最近是否成功：失败置 false，下一次成功自愈。用来发现「索引在、但每次查询都在失败」 */
    private volatile boolean queryHealthy = true;

    public VectorStore(EmbeddingProvider embedder, Path indexFile, ObjectMapper mapper) {
        this(embedder, indexFile, mapper, DEFAULT_BATCH);
    }

    public VectorStore(EmbeddingProvider embedder, Path indexFile, ObjectMapper mapper, int batchSize) {
        this.embedder = embedder;
        this.indexFile = indexFile;
        this.mapper = mapper;
        this.batchSize = Math.max(1, batchSize);
    }

    /** 供检索端固定引用，避免一次检索里混用新旧代 */
    public VecData snapshot() {
        return data.get();
    }

    public boolean semantic() {
        // 「provider 是不是语义的」与「语义路当下能不能用」是两件事：只报前者会出现
        // health 说 semantic=true、mode 却一直是 keyword 的上报与行为不一致。
        // 查询期失败也算不可用：索引在、但每次查询都失败时，语义路实际上没在做事。
        return embedder.semantic() && degradedReason == null && queryHealthy && !data.get().vectors().isEmpty();
    }

    /** provider 本身是否具备语义能力（与当下可用性无关）：用于区分「本来就是 bag」与「语义路挂了」 */
    public boolean supportsSemantic() {
        return embedder.semantic();
    }

    /** 查询期向量化最近是否成功（失败置 false，下一次成功自愈） */
    public boolean queryHealthy() {
        return queryHealthy;
    }

    /** 语义路不可用的原因；null = 正常 */
    public String degradedReason() {
        return degradedReason;
    }

    /** 构建成功、但查询期向量化失败的次数（外部服务中途不通）——语义路「静悄悄失效」的主要探测器 */
    public int queryFailures() {
        return queryFailures.get();
    }

    public String lastQueryError() {
        return lastQueryError;
    }

    /**
     * 重建向量索引。
     *
     * <p>失败<b>不抛出</b>：记下降级原因、退回空向量，检索仍能按关键词路独立工作。
     * 抛出去的后果是「embedding 服务抖一下，展板整个起不来」——现场没人能修，日志也没人看。
     * 失败时清空旧向量而不是沿用：知识改过之后旧向量与当前语料并非一一对应，
     * 沿用等于把两代数据混着检索，这类问题比降级更难查。
     */
    public void build(List<KnowledgeChunk> chunks) {
        Map<String, float[]> nextVectors = new LinkedHashMap<>();
        Map<String, KnowledgeChunk> nextById = new LinkedHashMap<>();
        String fingerprint = KnowledgeLoader.fingerprint(chunks);
        int dims = 0;
        try {
            for (int i = 0; i < chunks.size(); i += batchSize) {
                List<KnowledgeChunk> batch = chunks.subList(i, Math.min(chunks.size(), i + batchSize));
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
            if (!chunks.isEmpty() && dims == 0) {
                degrade("向量维度为 0（provider 返回了空向量）");
                return;
            }
            persist(chunks, nextVectors, dims, fingerprint);
        } catch (RuntimeException e) {
            degrade("向量索引构建失败：" + e.getMessage());
            return;
        }
        data.set(new VecData(nextVectors, nextById, embedder.name(), dims, fingerprint));
        degradedReason = null;
        log.info("[embed] 向量索引已重建：{} 块 / {} 维 / provider={} / 批次 {}",
                nextVectors.size(), dims, embedder.name(), batchSize);
    }

    private void degrade(String reason) {
        degradedReason = reason;
        data.set(VecData.empty());
        log.error("[embed] 语义路降级，检索退回仅关键词（关键词路不受影响）：{}", reason);
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
                degradedReason = null;
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
        List<float[]> embedded;
        try {
            embedded = embedder.embed(List.of(query));
            queryHealthy = true;
        } catch (RuntimeException e) {
            // 查询期向量化失败：本次检索退回仅关键词（不抛给调用方，免得一次外部抖动变成访客看到的报错）
            recordQueryFailure(e);
            return List.of();
        }
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

    private void recordQueryFailure(RuntimeException e) {
        lastQueryError = e.getMessage();
        queryHealthy = false;
        int n = queryFailures.incrementAndGet();
        // 外部服务挂了会每个请求都失败，日志不能被刷屏：只记第 1 次与每 50 次
        if (n == 1 || n % 50 == 0) {
            log.warn("[embed] 查询向量化失败第 {} 次，本次检索退回仅关键词：{}", n, e.getMessage());
        }
    }

    public VectorStats stats() {
        VecData d = data.get();
        return new VectorStats(
                d.providerName().isEmpty() ? embedder.name() : d.providerName(),
                semantic(),
                d.dims(),
                d.vectors().size(),
                d.fingerprint(),
                indexFile.toString(),
                degradedReason,
                queryFailures.get(),
                lastQueryError);
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
