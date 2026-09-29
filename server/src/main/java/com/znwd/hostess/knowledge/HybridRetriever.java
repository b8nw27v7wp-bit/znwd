package com.znwd.hostess.knowledge;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class HybridRetriever {

    private static final Logger log = LoggerFactory.getLogger(HybridRetriever.class);
    /** 向量检索降级 WARN 限流：每个实例最多每 60 秒输出一条，防止刷屏（实例字段：多 context/热部署时不互相压制） */
    private volatile long lastVectorDegradedLogMs;
    private static final long VECTOR_DEGRADED_LOG_INTERVAL_MS = 60_000;

    public static final double DEFAULT_MIN_KEYWORD_SCORE = 6.3;
    public static final double DEFAULT_MIN_VECTOR_SCORE = 0.75;

    private static final int RRF_K = 60;
    private static final double RRF_BOTH_BONUS = 0.01;

    private final VectorStore vectors;
    private final double minKeywordScore;
    private final double minVectorScore;
    private volatile Snapshot snapshot = new Snapshot(0, new Retriever(), VectorStore.VecData.empty(),
            Synonyms.snapshot(), false);

    public HybridRetriever(VectorStore vectors, double minKeywordScore, double minVectorScore) {
        this.vectors = vectors;
        this.minKeywordScore = minKeywordScore;
        this.minVectorScore = minVectorScore;
    }

    public long generation() {
        return snapshot.gen();
    }

    public synchronized void replace(List<KnowledgeChunk> chunks) {
        replace(chunks, Synonyms.snapshot());
    }

    public synchronized void replace(List<KnowledgeChunk> chunks, Synonyms.Version synonyms) {
        if (chunks == null || chunks.isEmpty()) {
            throw new IllegalArgumentException("知识库为空，拒绝发布 ready 快照");
        }
        List<KnowledgeChunk> source = List.copyOf(chunks);
        Set<String> ids = new HashSet<>();
        for (KnowledgeChunk chunk : source) {
            if (chunk == null || chunk.id() == null || chunk.id().isBlank() || !ids.add(chunk.id())) {
                throw new IllegalArgumentException("知识片段 id 为空或重复");
            }
        }
        Retriever nextKeyword = new Retriever();
        Synonyms.Version nextSynonyms = synonyms == null ? Synonyms.snapshot() : synonyms;
        nextKeyword.replace(source, nextSynonyms);
        if (!vectors.tryLoad(source)) {
            vectors.build(source);
        }
        VectorStore.VecData vectorData = vectors.snapshot();
        if (!vectorData.matches(source)) {
            vectorData = VectorStore.VecData.empty();
        }
        snapshot = new Snapshot(snapshot.gen() + 1, nextKeyword, vectorData, nextSynonyms, true);
    }

    public synchronized void refreshSynonyms() {
        refreshSynonyms(Synonyms.snapshot());
    }

    public synchronized void refreshSynonyms(Synonyms.Version synonyms) {
        Snapshot current = snapshot;
        if (!current.ready() || synonyms == null) {
            return;
        }
        if (current.synonyms().table().equals(synonyms.table())
                && current.synonyms().source().equals(synonyms.source())) {
            return;
        }
        snapshot = new Snapshot(current.gen() + 1, current.keyword(), current.vectorData(), synonyms, true);
    }

    public List<KnowledgeChunk> list() {
        return snapshot.keyword().list();
    }

    public List<RetrievedChunk> retrieveKeyword(String query, int topK) {
        Snapshot current = snapshot;
        return current.keyword().retrieve(query, topK, current.synonyms());
    }

    public List<HybridHit> retrieve(String query, int topK) {
        return retrieveWithDiagnostics(query, topK, false).hits();
    }

    public RetrievalOutcome retrieveWithDiagnostics(String query, int topK) {
        return retrieveWithDiagnostics(query, topK, true);
    }

    public RetrievalOutcome retrieveWithDiagnostics(String query, int topK, boolean applyGate) {
        Snapshot current = snapshot;
        int resultSize = Math.max(1, topK);
        int candidateSize = Math.max(resultSize * 2, 8);
        List<RetrievedChunk> keyword = current.keyword().retrieve(query, candidateSize, current.synonyms());
        double keywordBestScore = keyword.isEmpty() ? 0 : keyword.get(0).score();
        double keywordGateScore = keyword.isEmpty() ? 0 : keyword.get(0).gateScore();
        boolean keywordPass = !keyword.isEmpty() && keywordBestScore >= minKeywordScore;

        VectorStore.VecData vectorData = current.vectorData();
        boolean semantic = vectors.semantic(vectorData);
        List<VectorHit> raw = List.of();
        if (!keywordPass && semantic && !vectorData.vectors().isEmpty()) {
            try {
                raw = vectors.searchOn(vectorData, query, candidateSize);
                semantic = vectors.semantic(vectorData);
            } catch (RuntimeException e) {
                raw = List.of();
                semantic = false;
                long now = System.currentTimeMillis();
                if (now - lastVectorDegradedLogMs > VECTOR_DEGRADED_LOG_INTERVAL_MS) {
                    lastVectorDegradedLogMs = now;
                    log.warn("[retrieval] 向量检索失败，本问题只走关键词：{}（{}）", e.getClass().getSimpleName(), e.getMessage());
                }
            }
        }
        List<VectorHit> eligible = semantic ? alignVectorHits(raw, current.keyword().list()) : List.of();

        double vectorBestCosine = eligible.isEmpty() ? 0 : eligible.get(0).score();
        boolean vectorPass = !eligible.isEmpty() && vectorBestCosine >= minVectorScore;
        boolean gated = applyGate && !keywordPass && !vectorPass;
        List<RetrievedChunk> useKeyword = gated ? List.of() : keyword;
        boolean vectorHatch = !keywordPass && !eligible.isEmpty() && (vectorPass || !applyGate);
        List<VectorHit> useVector = gated || !semantic || keywordPass || !vectorHatch
                ? List.of() : eligible;

        RetrievalReason reason;
        if (keywordPass) {
            reason = RetrievalReason.KEYWORD_HIT;
        } else if (!useVector.isEmpty()) {
            reason = RetrievalReason.VECTOR_HIT;
        } else if (gated) {
            reason = keyword.isEmpty() && eligible.isEmpty()
                    ? RetrievalReason.NO_CANDIDATES : RetrievalReason.BELOW_THRESHOLD;
        } else if (!keyword.isEmpty()) {
            reason = RetrievalReason.KEYWORD_HIT;
        } else {
            reason = RetrievalReason.NO_CANDIDATES;
        }

        RetrievalMode mode = !useVector.isEmpty() ? RetrievalMode.HYBRID : RetrievalMode.KEYWORD;
        List<HybridHit> fused = rrfFuse(useKeyword, useVector);
        List<HybridHit> hits = fused.size() <= resultSize
                ? fused : new ArrayList<>(fused.subList(0, resultSize));
        int candidates = keyword.size() + countAdditionalCandidates(keyword, eligible);
        return new RetrievalOutcome(hits, new RetrievalDiagnostics(
                mode,
                semantic,
                !semantic,
                gated,
                reason,
                round(keywordGateScore, 4),
                round(keywordBestScore, 4),
                round(vectorBestCosine, 4),
                candidates,
                new RetrievalDiagnostics.Thresholds(minKeywordScore, minVectorScore)));
    }

    public HybridStats stats() {
        Snapshot current = snapshot;
        VectorStore.VecData vectorData = current.vectorData();
        boolean currentVector = vectors.isCurrent(vectorData)
                && vectorData.matches(current.keyword().list());
        VectorStats vectorStats = vectors.stats(vectors.snapshot());
        boolean semantic = vectors.semantic(vectorData) && currentVector;
        String degradedReason;
        if (!current.ready() || current.keyword().list().isEmpty()) {
            degradedReason = "知识快照未就绪";
        } else if (!vectors.supportsSemantic()) {
            degradedReason = "EMBED_PROVIDER=bag（特征哈希，非语义向量）";
        } else if (vectors.degradedReason() != null) {
            degradedReason = vectors.degradedReason();
        } else if (!vectors.queryHealthy()) {
            degradedReason = "查询期向量化失败（最近错误：" + vectors.lastQueryError() + "），检索已退回仅关键词";
        } else if (!currentVector) {
            degradedReason = "向量快照与关键词快照不一致";
        } else if (vectorStats.vectors() == 0) {
            degradedReason = "向量索引为空（尚未构建）";
        } else {
            degradedReason = null;
        }
        return new HybridStats(
                semantic && vectorStats.vectors() > 0 ? RetrievalMode.HYBRID : RetrievalMode.KEYWORD,
                current.keyword().list().size(),
                vectorStats,
                current.ready() && !current.keyword().list().isEmpty(),
                current.gen(),
                semantic,
                degradedReason,
                new RetrievalDiagnostics.Thresholds(minKeywordScore, minVectorScore));
    }

    private static List<VectorHit> alignVectorHits(List<VectorHit> vector, List<KnowledgeChunk> chunks) {
        if (vector.isEmpty() || chunks.isEmpty()) {
            return List.of();
        }
        Map<String, KnowledgeChunk> byId = new LinkedHashMap<>();
        for (KnowledgeChunk chunk : chunks) {
            byId.put(chunk.id(), chunk);
        }
        List<VectorHit> aligned = new ArrayList<>();
        for (VectorHit hit : vector) {
            KnowledgeChunk chunk = byId.get(hit.id());
            if (chunk != null) {
                aligned.add(new VectorHit(hit.id(), hit.score(), chunk));
            }
        }
        return aligned;
    }

    private static int countAdditionalCandidates(List<RetrievedChunk> keyword, List<VectorHit> vector) {
        Set<String> ids = new HashSet<>();
        for (RetrievedChunk hit : keyword) {
            ids.add(hit.chunk().id());
        }
        int count = 0;
        for (VectorHit hit : vector) {
            if (ids.add(hit.id())) {
                count++;
            }
        }
        return count;
    }

    private static List<HybridHit> rrfFuse(List<RetrievedChunk> keyword, List<VectorHit> vector) {
        Map<String, Acc> accumulated = new LinkedHashMap<>();
        for (int i = 0; i < keyword.size(); i++) {
            RetrievedChunk hit = keyword.get(i);
            accumulated.put(hit.chunk().id(), new Acc(hit.chunk(), hit.score(), 0,
                    hit.matched(), hit.matchedTokens(), i + 1, null));
        }
        for (int i = 0; i < vector.size(); i++) {
            VectorHit hit = vector.get(i);
            Acc previous = accumulated.get(hit.id());
            if (previous != null) {
                previous.vectorScore = hit.score();
                previous.vectorRank = i + 1;
            } else {
                accumulated.put(hit.id(), new Acc(hit.chunk(), 0, hit.score(), List.of(), 0, null, i + 1));
            }
        }
        List<HybridHit> result = new ArrayList<>();
        for (Acc item : accumulated.values()) {
            double keywordPart = item.keywordRank == null ? 0 : 1.0 / (RRF_K + item.keywordRank);
            double vectorPart = item.vectorRank == null ? 0 : 1.0 / (RRF_K + item.vectorRank);
            double fused = keywordPart + vectorPart
                    + (item.keywordRank != null && item.vectorRank != null ? RRF_BOTH_BONUS : 0);
            if (fused <= 0) {
                continue;
            }
            result.add(HybridHit.of(item.chunk, round(fused, 6), round(item.keywordScore, 4),
                    round(item.vectorScore, 4), item.matchedTokens, item.matched, round(fused, 6)));
        }
        result.sort(Comparator.comparingDouble(HybridHit::score).reversed());
        return result;
    }

    static double round(double value, int digits) {
        double factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }

    private static final class Acc {
        private final KnowledgeChunk chunk;
        private final double keywordScore;
        private double vectorScore;
        private final List<String> matched;
        private final int matchedTokens;
        private final Integer keywordRank;
        private Integer vectorRank;

        private Acc(KnowledgeChunk chunk, double keywordScore, double vectorScore, List<String> matched,
                    int matchedTokens, Integer keywordRank, Integer vectorRank) {
            this.chunk = chunk;
            this.keywordScore = keywordScore;
            this.vectorScore = vectorScore;
            this.matched = matched;
            this.matchedTokens = matchedTokens;
            this.keywordRank = keywordRank;
            this.vectorRank = vectorRank;
        }
    }

    private record Snapshot(long gen, Retriever keyword, VectorStore.VecData vectorData,
                            Synonyms.Version synonyms, boolean ready) {
    }
}
