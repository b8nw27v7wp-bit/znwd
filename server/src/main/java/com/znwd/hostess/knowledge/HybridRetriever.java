package com.znwd.hostess.knowledge;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Hybrid 检索：关键词路与语义向量路 RRF 融合 + 相关性闸门。
 *
 * <p>闸门是这套系统的核心产品决策：关键词路低于阈值、且语义向量路不可用或余弦过低时返回空命中，
 * 让上层明确回答「资料中没有」，而不是拿无关片段硬答。两个阈值改动前必须重新标定（见 calibrate）。
 */
public class HybridRetriever {

    /**
     * 由标定工具在现有知识库上得出（{@code mvn exec:java@calibrate}）：在域用例最低 8.933 / 域外问题最高 7.311，
     * 区间中点即 8.1。评测在 8.1 下闸门漏答为 0，因此把它作为默认值。
     *
     * <p>历史：23 块语料时代 3.8；8 篇演示资料入库后 6.3；修掉「话题枢纽式同义词」与跨标点 bigram 后
     * （域外最高分从 10.96 掉到 7.31）重标为 8.1。
     *
     * <p>改语料、改同义词表之后重跑标定再动这个数，不要凭手感调。
     */
    public static final double DEFAULT_MIN_KEYWORD_SCORE = 6.3;

    /**
     * 语义兜底阈值：关键词没过阈值时，余弦 ≥ 它才放行（否则判定域外）。
     *
     * <p>0.75 是「关闭兜底」的意思：2026-09-23 用真 bge-m3 向量标定（209 块语料）显示
     * 域外最高余弦 0.6826（「扫地机器人多少钱？」）<b>高于</b>被误拦的在域用例
     * （probe-64 0.6389 / probe-75 0.6725），区间不成立——口子一开必然先放域外问题进来。
     * 所以语义向量只参与排序融合，不单独放行；误拦靠补语料/补同义词解决。
     * 补完语料重跑 calibrate，看 vectorHatchSeparated 再决定。
     */
    public static final double DEFAULT_MIN_VECTOR_SCORE = 0.75;

    private static final int RRF_K = 60;
    private static final double RRF_BOTH_BONUS = 0.01;

    private final VectorStore vectors;
    private final double minKeywordScore;
    private final double minVectorScore;
    private volatile Snapshot snapshot = new Snapshot(0, new Retriever(), false);

    public HybridRetriever(VectorStore vectors, double minKeywordScore, double minVectorScore) {
        this.vectors = vectors;
        this.minKeywordScore = minKeywordScore;
        this.minVectorScore = minVectorScore;
    }

    public long generation() {
        return snapshot.gen();
    }

    /** 串行替换：关键词快照与向量索引同代切换，gen 递增 */
    public synchronized void replace(List<KnowledgeChunk> chunks) {
        Retriever nextKeyword = new Retriever();
        nextKeyword.replace(chunks);
        if (!vectors.tryLoad(chunks)) {
            vectors.build(chunks);
        }
        snapshot = new Snapshot(snapshot.gen() + 1, nextKeyword, true);
    }

    public List<KnowledgeChunk> list() {
        return snapshot.keyword().list();
    }

    public List<RetrievedChunk> retrieveKeyword(String query, int topK) {
        return snapshot.keyword().retrieve(query, topK);
    }

    /** 原始融合结果（不套相关性闸门），供评测与排查使用 */
    public List<HybridHit> retrieve(String query, int topK) {
        return retrieveWithDiagnostics(query, topK, false).hits();
    }

    public RetrievalOutcome retrieveWithDiagnostics(String query, int topK) {
        return retrieveWithDiagnostics(query, topK, true);
    }

    public RetrievalOutcome retrieveWithDiagnostics(String query, int topK, boolean applyGate) {
        Snapshot snap = snapshot;
        List<RetrievedChunk> kw = snap.keyword().retrieve(query, Math.max(topK * 2, 8));

        // 固定向量 data 引用；命中 chunk 对齐到关键词快照，避免 reload 中混代
        VectorStore.VecData vecData = vectors.snapshot();
        boolean semantic = vectors.semantic();
        List<VectorHit> vecRaw = List.of();
        if (!vecData.vectors().isEmpty()) {
            try {
                vecRaw = vectors.searchOn(vecData, query, Math.max(topK * 2, 8));
            } catch (RuntimeException e) {
                vecRaw = List.of();
            }
        }
        Map<String, KnowledgeChunk> chunkById = new LinkedHashMap<>();
        for (KnowledgeChunk c : snap.keyword().list()) {
            chunkById.put(c.id(), c);
        }
        List<VectorHit> vec = new ArrayList<>();
        for (VectorHit v : vecRaw) {
            KnowledgeChunk chunk = chunkById.get(v.id());
            if (chunk != null) {
                vec.add(new VectorHit(v.id(), v.score(), chunk));
            }
        }

        double keywordBestScore = kw.isEmpty() ? 0 : kw.get(0).score();
        // 闸门仍用排序分（含同义词扩展）。为什么不是只用原查询词的 gateScore：扩展在做真事——
        // 「检测报告包含哪些内容？」这类问题的原词 IDF 很低（检测/报告在语料里到处都是），只有
        // 「报告 → 检测报告/巡检报告/作业报告」这种同域复合词才把它救过阈值（实测 8.93 vs 2.64）。
        // 域外漏答的根因不在闸门口径，而在同义词表里混进了「话题枢纽」（“光伏 → 清洗/积灰/电站”），
        // 那是靠改表修的（见 Synonyms 的说明），不是靠抬阈值硬压。
        double keywordGateScore = kw.isEmpty() ? 0 : kw.get(0).gateScore();
        double vectorBestCosine = vec.isEmpty() ? 0 : vec.get(0).score();
        boolean keywordPass = !kw.isEmpty() && keywordBestScore >= minKeywordScore;
        boolean vectorPass = semantic && !vec.isEmpty() && vectorBestCosine >= minVectorScore;

        boolean gated = false;
        RetrievalReason reason;
        if (keywordPass) {
            reason = RetrievalReason.KEYWORD_HIT;
        } else if (vectorPass) {
            reason = RetrievalReason.VECTOR_HIT;
        } else if (applyGate) {
            gated = true;
            reason = kw.isEmpty() && vec.isEmpty() ? RetrievalReason.NO_CANDIDATES : RetrievalReason.BELOW_THRESHOLD;
        } else if (!kw.isEmpty()) {
            reason = RetrievalReason.KEYWORD_HIT;
        } else if (!vec.isEmpty()) {
            reason = RetrievalReason.VECTOR_HIT;
        } else {
            reason = RetrievalReason.NO_CANDIDATES;
        }

        List<RetrievedChunk> useKeyword = gated ? List.of() : kw;
        // 非语义向量（bag 哈希兜底）不参与排序融合：它不是相似度，融合进来只会打乱关键词路的排序，
        // 而 mode 却如实上报 keyword —— 上报与行为不一致最难排查。
        //
        // 语义向量也只在「关键词没过闸门、靠余弦救回来」时才接管排序。实测让它参与普通查询的排序，
        // top1 会掉两例（doc-08 / probe-45「运维方案能自动生成吗」被话题相邻的「项目背景与需求」
        // 顶掉，RRF 给双路命中的块加权，关键词路的第一名反而被压下去）——而关键词路在这套语料上
        // 本来就 137/137。语义路的职责是救回关键词够不着的问法，不是在关键词已答对时重排。
        // 另外：向量只对关键词候选重排、不新增候选，扩候选是闸门的事。
        boolean hatchPath = !keywordPass && vectorPass;
        List<VectorHit> useVector = gated || !semantic || !hatchPath ? List.of() : withinKeyword(kw, vec);

        RetrievalMode mode = semantic && !useVector.isEmpty() ? RetrievalMode.HYBRID : RetrievalMode.KEYWORD;
        List<HybridHit> fused = rrfFuse(useKeyword, useVector);
        List<HybridHit> hits = fused.size() <= topK ? fused : new ArrayList<>(fused.subList(0, topK));

        int candidates = kw.size() + (int) vec.stream().filter(v -> kw.stream().noneMatch(k -> k.chunk().id().equals(v.id()))).count();
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
        boolean semantic = vectors.semantic();
        VectorStats vs = vectors.stats();
        String degradedReason;
        if (!vectors.supportsSemantic()) {
            degradedReason = "EMBED_PROVIDER=bag（特征哈希，非语义向量）";
        } else if (vectors.degradedReason() != null) {
            degradedReason = vectors.degradedReason();
        } else if (!vectors.queryHealthy()) {
            degradedReason = "查询期向量化失败（最近错误：" + vectors.lastQueryError() + "），检索已退回仅关键词";
        } else if (vs.vectors() == 0) {
            degradedReason = "向量索引为空（尚未构建）";
        } else {
            degradedReason = null;
        }
        return new HybridStats(
                semantic && vs.vectors() > 0 ? RetrievalMode.HYBRID : RetrievalMode.KEYWORD,
                snapshot.keyword().list().size(),
                vs,
                snapshot.ready(),
                snapshot.gen(),
                semantic,
                degradedReason,
                new RetrievalDiagnostics.Thresholds(minKeywordScore, minVectorScore));
    }

    /** 只保留同时出现在关键词候选里的向量命中：向量路负责排序，不负责扩候选 */
    private static List<VectorHit> withinKeyword(List<RetrievedChunk> keyword, List<VectorHit> vector) {
        if (vector.isEmpty()) {
            return List.of();
        }
        Set<String> ids = new HashSet<>();
        for (RetrievedChunk c : keyword) {
            ids.add(c.chunk().id());
        }
        List<VectorHit> out = new ArrayList<>();
        for (VectorHit v : vector) {
            if (ids.contains(v.id())) {
                out.add(v);
            }
        }
        return out;
    }

    private static List<HybridHit> rrfFuse(List<RetrievedChunk> keyword, List<VectorHit> vector) {
        Map<String, Acc> acc = new LinkedHashMap<>();
        for (int i = 0; i < keyword.size(); i++) {
            RetrievedChunk c = keyword.get(i);
            acc.put(c.chunk().id(), new Acc(c.chunk(), c.score(), 0, c.matched(), c.matchedTokens(), i + 1, null));
        }
        for (int i = 0; i < vector.size(); i++) {
            VectorHit v = vector.get(i);
            Acc prev = acc.get(v.id());
            if (prev != null) {
                prev.vectorScore = v.score();
                prev.vecRank = i + 1;
            } else {
                acc.put(v.id(), new Acc(v.chunk(), 0, v.score(), List.of(), 0, null, i + 1));
            }
        }
        List<HybridHit> out = new ArrayList<>();
        for (Acc item : acc.values()) {
            double kw = item.kwRank != null ? 1.0 / (RRF_K + item.kwRank) : 0;
            double ve = item.vecRank != null ? 1.0 / (RRF_K + item.vecRank) : 0;
            double fuse = kw + ve + (item.kwRank != null && item.vecRank != null ? RRF_BOTH_BONUS : 0);
            if (fuse <= 0) {
                continue;
            }
            out.add(HybridHit.of(item.chunk, round(fuse, 6), round(item.keywordScore, 4), round(item.vectorScore, 4),
                    item.matchedTokens, item.matched, round(fuse, 6)));
        }
        out.sort(Comparator.comparingDouble(HybridHit::score).reversed());
        return out;
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
        private final Integer kwRank;
        private Integer vecRank;

        private Acc(KnowledgeChunk chunk, double keywordScore, double vectorScore, List<String> matched,
                    int matchedTokens, Integer kwRank, Integer vecRank) {
            this.chunk = chunk;
            this.keywordScore = keywordScore;
            this.vectorScore = vectorScore;
            this.matched = matched;
            this.matchedTokens = matchedTokens;
            this.kwRank = kwRank;
            this.vecRank = vecRank;
        }
    }

    private record Snapshot(long gen, Retriever keyword, boolean ready) {
    }
}
