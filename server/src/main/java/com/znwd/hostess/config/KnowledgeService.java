package com.znwd.hostess.config;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;

import com.znwd.hostess.knowledge.HybridRetriever;
import com.znwd.hostess.knowledge.HybridStats;
import com.znwd.hostess.knowledge.KnowledgeChunk;
import com.znwd.hostess.knowledge.KnowledgeLoader;
import com.znwd.hostess.knowledge.Synonyms;
import com.znwd.hostess.knowledge.VectorStore;
import com.znwd.hostess.knowledge.ZonesMeta;

/**
 * 知识库门面：启动加载、手动 reload、可选的目录监听热更新。
 *
 * <p>reload 后必须让答案缓存失效（调用方负责），否则会拿旧索引时代生成的答案继续回答。
 */
public class KnowledgeService {

    private static final Logger log = LoggerFactory.getLogger(KnowledgeService.class);

    private final KnowledgeLoader loader;
    private final HybridRetriever retriever;
    private final VectorStore vectorStore;
    private final Path knowledgeDir;
    private final boolean watchEnabled;

    private volatile Runnable onReloaded = () -> {
    };

    public KnowledgeService(
            KnowledgeLoader loader, HybridRetriever retriever, VectorStore vectorStore, Path knowledgeDir, boolean watchEnabled) {
        this.loader = loader;
        this.retriever = retriever;
        this.vectorStore = vectorStore;
        this.knowledgeDir = knowledgeDir;
        this.watchEnabled = watchEnabled;
    }

    /** 启动时加载（构造后由 Spring 调用，失败直接启动失败——宁可起不来也别拿空知识库对外服务） */
    public void loadInitial() {
        int chunks = reloadInternal();
        log.info("[knowledge] 已加载 {} 个片段 dir={} embed={} mode={}",
                chunks, knowledgeDir, vectorStore.stats().provider(), retriever.stats().mode());
    }

    public void setOnReloaded(Runnable callback) {
        this.onReloaded = callback;
    }

    public int reload() {
        int chunks = reloadInternal();
        onReloaded.run();
        return chunks;
    }

    /** 只让答案缓存失效（同义词这类"查询时生效"的改动不需要重建索引，但缓存必须清） */
    public void invalidateAnswerCache() {
        onReloaded.run();
    }

    /**
     * 同义词覆盖表：{@code <knowledgeDir>/_meta/synonyms.tsv}。
     * 存在就加载；文件被删掉且当前表正是它提供的，就退回内置表——否则"删了文件还生效"最难排查。
     */
    public int loadSynonyms() {
        Path file = synonymsFile();
        try {
            int loaded = Synonyms.loadFromFile(file);
            if (loaded > 0) {
                log.info("[knowledge] 同义词覆盖表已加载：{} 条 <- {}", loaded, file);
                return loaded;
            }
            if (file.toString().equals(Synonyms.source())) {
                Synonyms.resetDefaults();
                log.info("[knowledge] 同义词覆盖表已移除，退回内置表（{} 条）", Synonyms.size());
            }
            return 0;
        } catch (IOException | RuntimeException e) {
            // 覆盖表坏了不能把服务带下去：保留当前生效的表，报出来让人来修
            log.error("[knowledge] 同义词覆盖表加载失败，保留当前表：{}", file, e);
            return 0;
        }
    }

    public Path synonymsFile() {
        return knowledgeDir.resolve("_meta/synonyms.tsv");
    }

    private int reloadInternal() {
        List<KnowledgeChunk> chunks = loader.load(knowledgeDir);
        retriever.replace(chunks);
        loadSynonyms();
        return chunks.size();
    }

    public Path knowledgeDir() {
        return knowledgeDir;
    }

    public boolean watchEnabled() {
        return watchEnabled;
    }

    public HybridRetriever retriever() {
        return retriever;
    }

    public ZonesMeta zonesMeta() {
        return loader.loadZonesMeta(knowledgeDir);
    }

    public List<KnowledgeChunk> chunks() {
        return retriever.list();
    }

    public HybridStats stats() {
        return retriever.stats();
    }

    /** 按文件聚合的分块统计（/api/knowledge/list） */
    public Map<String, FileStat> byFile() {
        Map<String, FileStat> byFile = new LinkedHashMap<>();
        for (KnowledgeChunk c : chunks()) {
            FileStat prev = byFile.get(c.sourcePath());
            if (prev == null) {
                byFile.put(c.sourcePath(), new FileStat(c.title(), c.zone(), c.zoneTitle(), 1));
            } else {
                byFile.put(c.sourcePath(), new FileStat(prev.title(), prev.zone(), prev.zoneTitle(), prev.chunks() + 1));
            }
        }
        return byFile;
    }

    /**
     * 目录监听（KNOWLEDGE_WATCH=true，默认关闭）。
     * Windows 上文件监听不稳定，展厅现场请用手动 reload；这里用低频轮询（每 10s 比对指纹）代替 fs watch。
     */
    @Scheduled(fixedDelay = 10_000L, initialDelay = 10_000L)
    public void watchTick() {
        if (!watchEnabled) {
            return;
        }
        String current = fingerprint();
        if (current == null || current.equals(lastFingerprint)) {
            return;
        }
        lastFingerprint = current;
        try {
            int chunks = reload();
            log.info("[knowledge] 热更新重载完成：{} 个片段", chunks);
        } catch (RuntimeException e) {
            log.error("[knowledge] 热更新失败", e);
        }
    }

    private volatile String lastFingerprint;

    private String fingerprint() {
        try (Stream<Path> stream = Files.walk(knowledgeDir)) {
            return stream.filter(Files::isRegularFile)
                    .filter(p -> !p.toString().contains("_meta"))
                    .sorted(Comparator.comparing(Path::toString))
                    .map(p -> p + ":" + size(p) + ":" + modified(p))
                    .reduce("", (a, b) -> a + "|" + b);
        } catch (IOException e) {
            return null;
        }
    }

    private static long size(Path p) {
        try {
            return Files.size(p);
        } catch (IOException e) {
            return 0;
        }
    }

    private static long modified(Path p) {
        try {
            return Files.getLastModifiedTime(p).toMillis();
        } catch (IOException e) {
            return 0;
        }
    }

    public record FileStat(String title, String zone, String zoneTitle, int chunks) {
    }
}
