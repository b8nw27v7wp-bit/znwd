package com.znwd.hostess.knowledge;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.HashSet;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.embedding.EmbeddingException;
import com.znwd.hostess.embedding.EmbeddingProvider;
import com.znwd.hostess.embedding.Vectors;

public class VectorStore {

    private static final Logger log = LoggerFactory.getLogger(VectorStore.class);

    private static final int INDEX_VERSION = 2;
    private static final int DEFAULT_BATCH = 32;
    private static final long QUERY_RETRY_COOLDOWN_MS = 60_000L;

    private final EmbeddingProvider embedder;
    private final EmbeddingIdentity identity;
    private final Path indexFile;
    private final ObjectMapper mapper;
    private final int batchSize;
    private final long queryRetryCooldownMs;
    private final AtomicReference<VecData> data = new AtomicReference<>(VecData.empty());
    private final AtomicInteger queryFailures = new AtomicInteger();
    private final AtomicBoolean queryProbeInFlight = new AtomicBoolean();
    private volatile String degradedReason;
    private volatile String lastQueryError;
    private volatile boolean queryHealthy = true;
    private volatile long nextQueryProbeAt;
    private long generation;

    public VectorStore(EmbeddingProvider embedder, Path indexFile, ObjectMapper mapper) {
        this(embedder, indexFile, mapper, DEFAULT_BATCH);
    }

    public VectorStore(EmbeddingProvider embedder, Path indexFile, ObjectMapper mapper, int batchSize) {
        this(embedder, indexFile, mapper, batchSize, QUERY_RETRY_COOLDOWN_MS);
    }

    VectorStore(EmbeddingProvider embedder, Path indexFile, ObjectMapper mapper, int batchSize,
                long queryRetryCooldownMs) {
        if (embedder == null) {
            throw new IllegalArgumentException("embedder 不能为空");
        }
        this.embedder = embedder;
        this.identity = EmbeddingIdentity.of(embedder);
        this.indexFile = indexFile;
        this.mapper = mapper;
        this.batchSize = Math.max(1, batchSize);
        this.queryRetryCooldownMs = Math.max(0, queryRetryCooldownMs);
    }

    public VecData snapshot() {
        return data.get();
    }

    public boolean semantic() {
        return semantic(snapshot());
    }

    public boolean semantic(VecData candidate) {
        boolean probeReady = queryHealthy || System.currentTimeMillis() >= nextQueryProbeAt;
        return embedder.semantic()
                && degradedReason == null
                && probeReady
                && candidate != null
                && !candidate.vectors().isEmpty();
    }

    public boolean supportsSemantic() {
        return embedder.semantic();
    }

    public boolean queryHealthy() {
        return queryHealthy;
    }

    public String degradedReason() {
        return degradedReason;
    }

    public int queryFailures() {
        return queryFailures.get();
    }

    public String lastQueryError() {
        return lastQueryError;
    }

    public synchronized void build(List<KnowledgeChunk> chunks) {
        if (chunks == null || chunks.isEmpty()) {
            degrade("知识库为空，拒绝发布空向量索引");
            return;
        }
        List<KnowledgeChunk> source = List.copyOf(chunks);
        String fingerprint = KnowledgeLoader.fingerprint(source);
        Map<String, float[]> nextVectors = new LinkedHashMap<>();
        Map<String, KnowledgeChunk> nextById = new LinkedHashMap<>();
        int actualDims = 0;
        try {
            validateChunkIds(source);
            for (int i = 0; i < source.size(); i += batchSize) {
                List<KnowledgeChunk> batch = source.subList(i, Math.min(source.size(), i + batchSize));
                List<String> texts = new ArrayList<>(batch.size());
                for (KnowledgeChunk chunk : batch) {
                    texts.add(embeddingText(chunk));
                }
                List<float[]> vectors = embedder.embed(texts);
                if (vectors == null || vectors.size() != batch.size()) {
                    throw new EmbeddingException("向量数量不匹配："
                            + (vectors == null ? 0 : vectors.size()) + " != " + batch.size());
                }
                for (int j = 0; j < batch.size(); j++) {
                    KnowledgeChunk chunk = batch.get(j);
                    float[] vector = copyAndValidate(vectors.get(j),
                            actualDims > 0 ? actualDims : identity.configuredDims(), "构建");
                    if (actualDims == 0) {
                        actualDims = vector.length;
                    }
                    nextById.put(chunk.id(), chunk);
                    nextVectors.put(chunk.id(), vector);
                }
            }
            if (actualDims <= 0) {
                throw new EmbeddingException("向量维度为 0");
            }
            persist(source, nextVectors, actualDims, fingerprint);
            VecData next = new VecData(nextVectors, nextById, embedder.name(), actualDims, fingerprint,
                    ++generation);
            data.set(next);
            degradedReason = null;
            queryHealthy = true;
            nextQueryProbeAt = 0;
            log.info("[embed] 向量索引已重建：{} 块 / {} 维 / provider={} model={} endpoint={} / 批次 {}",
                    nextVectors.size(), actualDims, identity.provider(), identity.model(), identity.endpoint(), batchSize);
        } catch (RuntimeException e) {
            degrade("向量索引构建失败：" + describe(e));
        }
    }

    private void degrade(String reason) {
        String safeReason = safeReason(reason);
        degradedReason = safeReason;
        data.set(VecData.empty(++generation));
        log.error("[embed] 语义路降级，检索退回仅关键词（关键词路不受影响）：{}", safeReason);
    }

    public synchronized boolean tryLoad(List<KnowledgeChunk> chunks) {
        if (chunks == null || chunks.isEmpty()) {
            return false;
        }
        String fingerprint = KnowledgeLoader.fingerprint(chunks);
        try {
            if (indexFile == null || !Files.isRegularFile(indexFile)) {
                return false;
            }
            IndexFile parsed = mapper.readValue(Files.readString(indexFile, StandardCharsets.UTF_8), IndexFile.class);
            if (parsed == null || parsed.version() != INDEX_VERSION || !identity.matches(parsed)) {
                return false;
            }
            if (!fingerprint.equals(parsed.fingerprint())
                    || !fingerprint.equals(parsed.embeddingFingerprint())
                    || parsed.items() == null
                    || parsed.items().size() != chunks.size()) {
                return false;
            }
            validateChunkIds(chunks);
            Map<String, IndexItem> items = new LinkedHashMap<>();
            for (IndexItem item : parsed.items()) {
                if (item == null || item.id() == null || items.putIfAbsent(item.id(), item) != null) {
                    return false;
                }
            }
            int declaredDims = identity.configuredDims();
            if (parsed.dims() <= 0 || (declaredDims > 0 && parsed.dims() != declaredDims)) {
                return false;
            }
            Map<String, float[]> nextVectors = new LinkedHashMap<>();
            Map<String, KnowledgeChunk> nextById = new LinkedHashMap<>();
            for (KnowledgeChunk chunk : chunks) {
                IndexItem item = items.get(chunk.id());
                if (item == null) {
                    return false;
                }
                float[] vector = copyAndValidate(item.vector(), parsed.dims(), "加载");
                nextById.put(chunk.id(), chunk);
                nextVectors.put(chunk.id(), vector);
            }
            if (nextVectors.size() != chunks.size()) {
                return false;
            }
            data.set(new VecData(nextVectors, nextById, embedder.name(), parsed.dims(), fingerprint, ++generation));
            degradedReason = null;
            queryHealthy = true;
            nextQueryProbeAt = 0;
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    public List<VectorHit> search(String query, int topK) {
        return searchOn(snapshot(), query, topK);
    }

    public List<VectorHit> searchOn(VecData candidate, String query, int topK) {
        if (candidate == null || candidate.vectors().isEmpty() || topK <= 0) {
            return List.of();
        }
        List<float[]> embedded;
        boolean probing = !queryHealthy;
        if (probing && !queryProbeInFlight.compareAndSet(false, true)) {
            return List.of();
        }
        try {
            embedded = embedder.embed(List.of(query == null ? "" : query));
            queryHealthy = true;
            nextQueryProbeAt = 0;
        } catch (RuntimeException e) {
            recordQueryFailure(e);
            if (probing) queryProbeInFlight.set(false);
            return List.of();
        }
        if (embedded == null || embedded.size() != 1) {
            recordQueryFailure(new EmbeddingException("查询向量数量不匹配"));
            if (probing) queryProbeInFlight.set(false);
            return List.of();
        }
        float[] queryVector;
        try {
            queryVector = copyAndValidate(embedded.get(0), candidate.dims(), "查询");
        } catch (RuntimeException e) {
            recordQueryFailure(e);
            if (probing) queryProbeInFlight.set(false);
            return List.of();
        }
        List<VectorHit> hits = new ArrayList<>(candidate.vectors().size());
        for (Map.Entry<String, float[]> entry : candidate.vectors().entrySet()) {
            KnowledgeChunk chunk = candidate.byId().get(entry.getKey());
            float[] vector = entry.getValue();
            if (chunk == null || !validVector(vector, candidate.dims())) {
                continue;
            }
            double score = Vectors.cosine(queryVector, vector);
            if (Double.isFinite(score)) {
                hits.add(new VectorHit(entry.getKey(), score, chunk));
            }
        }
        hits.sort(Comparator.comparingDouble(VectorHit::score).reversed());
        if (probing) queryProbeInFlight.set(false);
        return hits.size() <= topK ? hits : new ArrayList<>(hits.subList(0, topK));
    }

    public boolean isCurrent(VecData candidate) {
        return candidate != null && candidate.generation() == data.get().generation();
    }

    private void recordQueryFailure(RuntimeException e) {
        lastQueryError = safeReason(describe(e));
        queryHealthy = false;
        nextQueryProbeAt = System.currentTimeMillis() + queryRetryCooldownMs;
        int n = queryFailures.incrementAndGet();
        if (n == 1 || n % 50 == 0) {
            log.warn("[embed] 查询向量化失败第 {} 次，本次检索退回仅关键词：{}", n, lastQueryError);
        }
    }

    public VectorStats stats() {
        return stats(snapshot());
    }

    public VectorStats stats(VecData candidate) {
        VecData current = candidate == null ? VecData.empty() : candidate;
        return new VectorStats(
                current.providerName().isEmpty() ? embedder.name() : current.providerName(),
                semantic(current),
                current.dims(),
                current.vectors().size(),
                current.fingerprint(),
                indexFile == null ? "" : indexFile.toString(),
                degradedReason,
                queryFailures.get(),
                lastQueryError);
    }

    public String embeddingModel() {
        return identity.model();
    }

    public String endpointIdentity() {
        return identity.endpoint();
    }

    public static String embeddingText(KnowledgeChunk chunk) {
        return KnowledgeLoader.embeddingText(chunk);
    }

    private void persist(List<KnowledgeChunk> chunks, Map<String, float[]> vectors, int dims, String fingerprint) {
        List<IndexItem> items = new ArrayList<>(chunks.size());
        for (KnowledgeChunk chunk : chunks) {
            items.add(new IndexItem(chunk.id(), Vectors.toList(vectors.get(chunk.id()))));
        }
        IndexFile payload = new IndexFile(INDEX_VERSION, identity.provider(), identity.model(), identity.endpoint(),
                dims, fingerprint, fingerprint, java.time.Instant.now().toString(), items);
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

    private static void validateChunkIds(List<KnowledgeChunk> chunks) {
        Set<String> ids = new HashSet<>();
        for (KnowledgeChunk chunk : chunks) {
            if (chunk == null || chunk.id() == null || chunk.id().isBlank() || !ids.add(chunk.id())) {
                throw new EmbeddingException("知识片段 id 为空或重复");
            }
        }
    }

    private static float[] copyAndValidate(float[] source, int expectedDims, String phase) {
        if (source == null || source.length == 0) {
            throw new EmbeddingException(phase + "向量为空");
        }
        if (expectedDims > 0 && source.length != expectedDims) {
            throw new EmbeddingException(phase + "向量维度不匹配：" + source.length + " != " + expectedDims);
        }
        for (float value : source) {
            if (!Float.isFinite(value)) {
                throw new EmbeddingException(phase + "向量包含非有限值");
            }
        }
        return source.clone();
    }

    private static float[] copyAndValidate(List<Float> source, int expectedDims, String phase) {
        if (source == null || source.isEmpty()) {
            throw new EmbeddingException(phase + "向量为空");
        }
        float[] result = new float[source.size()];
        for (int i = 0; i < source.size(); i++) {
            Float value = source.get(i);
            if (value == null) {
                throw new EmbeddingException(phase + "向量包含空值");
            }
            result[i] = value;
        }
        return copyAndValidate(result, expectedDims, phase);
    }

    private static boolean validVector(float[] vector, int expectedDims) {
        if (vector == null || vector.length == 0 || (expectedDims > 0 && vector.length != expectedDims)) {
            return false;
        }
        for (float value : vector) {
            if (!Float.isFinite(value)) {
                return false;
            }
        }
        return true;
    }

    private static String safeReason(String value) {
        if (value == null) {
            return "未知错误";
        }
        String safe = value.replaceAll("(?i)https?://\\S+", "<endpoint>");
        return safe.length() <= 240 ? safe : safe.substring(0, 240) + "…";
    }

    private static String describe(Throwable error) {
        if (error == null) {
            return "未知错误";
        }
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }

    private record EmbeddingIdentity(String provider, String model, String endpoint, int configuredDims) {

        private static EmbeddingIdentity of(EmbeddingProvider embedder) {
            return new EmbeddingIdentity(value(embedder.name()), value(embedder.embeddingModel()),
                    value(embedder.endpointIdentity()), Math.max(0, embedder.dims()));
        }

        private boolean matches(IndexFile file) {
            return file != null
                    && provider.equals(file.provider())
                    && model.equals(file.model())
                    && endpoint.equals(file.endpoint());
        }

        private static String value(String value) {
            return value == null ? "" : value.strip();
        }
    }

    public record VecData(
            Map<String, float[]> vectors,
            Map<String, KnowledgeChunk> byId,
            String providerName,
            int dims,
            String fingerprint,
            long generation) {

        public VecData(Map<String, float[]> vectors, Map<String, KnowledgeChunk> byId,
                       String providerName, int dims, String fingerprint) {
            this(vectors, byId, providerName, dims, fingerprint, 0);
        }

        public VecData(Map<String, float[]> vectors, Map<String, KnowledgeChunk> byId,
                       String providerName, int dims, String fingerprint, long generation) {
            Map<String, float[]> safeVectors = vectors == null ? Map.of() : vectors;
            Map<String, float[]> copiedVectors = new LinkedHashMap<>();
            safeVectors.forEach((id, vector) -> copiedVectors.put(id,
                    vector == null ? new float[0] : vector.clone()));
            this.vectors = Collections.unmodifiableMap(copiedVectors);
            this.byId = Collections.unmodifiableMap(new LinkedHashMap<>(
                    byId == null ? Map.of() : byId));
            this.providerName = providerName == null ? "" : providerName;
            this.dims = dims;
            this.fingerprint = fingerprint == null ? "" : fingerprint;
            this.generation = generation;
        }

        public static VecData empty() {
            return new VecData(Map.of(), Map.of(), "", 0, "", 0);
        }

        public static VecData empty(long generation) {
            return new VecData(Map.of(), Map.of(), "", 0, "", generation);
        }

        public boolean matches(List<KnowledgeChunk> chunks) {
            if (chunks == null || chunks.isEmpty() || fingerprint.isEmpty()
                    || vectors.size() != chunks.size() || byId.size() != chunks.size()) {
                return false;
            }
            String expected = KnowledgeLoader.fingerprint(chunks);
            if (!fingerprint.equals(expected)) {
                return false;
            }
            for (KnowledgeChunk chunk : chunks) {
                if (chunk == null || !vectors.containsKey(chunk.id()) || !byId.containsKey(chunk.id())) {
                    return false;
                }
            }
            return true;
        }
    }

    @JsonPropertyOrder({"version", "provider", "model", "endpoint", "dims", "fingerprint",
            "embeddingFingerprint", "updatedAt", "items"})
    public record IndexFile(int version, String provider, String model, String endpoint, int dims,
                            String fingerprint, String embeddingFingerprint, String updatedAt,
                            List<IndexItem> items) {

        public IndexFile(int version, String provider, int dims, String fingerprint, String updatedAt,
                         List<IndexItem> items) {
            this(version, provider, "", "", dims, fingerprint, fingerprint, updatedAt, items);
        }
    }

    public record IndexItem(String id, List<Float> vector) {
    }
}
