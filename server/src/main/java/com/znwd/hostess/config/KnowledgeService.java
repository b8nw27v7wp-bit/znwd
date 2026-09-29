package com.znwd.hostess.config;

import java.io.IOException;
import java.io.UncheckedIOException;
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
import com.znwd.hostess.rag.PromptStore;

public class KnowledgeService {

    private static final Logger log = LoggerFactory.getLogger(KnowledgeService.class);

    private final KnowledgeLoader loader;
    private final HybridRetriever retriever;
    private final VectorStore vectorStore;
    private final Path knowledgeDir;
    private final boolean watchEnabled;
    /** Prompt 外置的重载钩子：null = 不挂（纯检索测试场景） */
    private final PromptStore prompts;
    private volatile Runnable onReloaded = () -> {
    };
    private volatile String lastFingerprint;

    public KnowledgeService(
            KnowledgeLoader loader, HybridRetriever retriever, VectorStore vectorStore, Path knowledgeDir, boolean watchEnabled) {
        this(loader, retriever, vectorStore, knowledgeDir, watchEnabled, null);
    }

    public KnowledgeService(
            KnowledgeLoader loader, HybridRetriever retriever, VectorStore vectorStore, Path knowledgeDir,
            boolean watchEnabled, PromptStore prompts) {
        this.loader = loader;
        this.retriever = retriever;
        this.vectorStore = vectorStore;
        this.knowledgeDir = knowledgeDir;
        this.watchEnabled = watchEnabled;
        this.prompts = prompts;
    }

    public synchronized void loadInitial() {
        String before = fingerprintOrNull();
        int chunks = reloadInternal();
        lastFingerprint = stableFingerprint(before, "初始化");
        log.info("[knowledge] 已加载 {} 个片段 dir={} embed={} mode={}",
                chunks, knowledgeDir, vectorStore.stats().provider(), retriever.stats().mode());
    }

    public void setOnReloaded(Runnable callback) {
        this.onReloaded = callback == null ? () -> {
        } : callback;
    }

    public synchronized int reload() {
        // 顺带重读 prompt 外置文件：与知识热更新同一条操作路径（POST /api/knowledge/reload）。
        // 放在最前且自己兜底——prompt 读失败只回退默认文本，绝不能把知识重载一起带崩。
        reloadPrompts();
        String before = fingerprintOrNull();
        int chunks = reloadInternal();
        lastFingerprint = stableFingerprint(before, "reload");
        onReloaded.run();
        return chunks;
    }

    private void reloadPrompts() {
        if (prompts == null) {
            return;
        }
        try {
            prompts.reload();
        } catch (RuntimeException e) {
            log.error("[knowledge] prompt 重载失败，保留当前 prompt 文本", e);
        }
    }

    public synchronized void invalidateAnswerCache() {
        retriever.refreshSynonyms();
        onReloaded.run();
    }

    public synchronized int loadSynonyms() {
        Path file = synonymsFile();
        try {
            Synonyms.Version prepared = Synonyms.prepareFromFile(file);
            if (prepared != null) {
                Synonyms.activate(prepared);
                retriever.refreshSynonyms();
                log.info("[knowledge] 同义词覆盖表已加载：{} 条 <- {}", prepared.table().size(), file);
                return prepared.table().size();
            }
            if (file.toString().equals(Synonyms.source())) {
                Synonyms.resetDefaults();
                retriever.refreshSynonyms();
                log.info("[knowledge] 同义词覆盖表已移除，退回内置表（{} 条）", Synonyms.size());
            }
            return 0;
        } catch (IOException | RuntimeException e) {
            log.error("[knowledge] 同义词覆盖表加载失败，保留当前表：{}", file, e);
            return 0;
        }
    }

    public Path synonymsFile() {
        return knowledgeDir.resolve("_meta/synonyms.tsv");
    }

    private int reloadInternal() {
        if (knowledgeDir == null || !Files.isDirectory(knowledgeDir)) {
            throw new IllegalStateException("知识库目录不存在或不是目录：" + knowledgeDir);
        }
        List<KnowledgeChunk> chunks = loader.load(knowledgeDir);
        if (chunks == null || chunks.isEmpty()) {
            throw new IllegalStateException("知识库为空，拒绝发布快照");
        }
        Synonyms.Version current = Synonyms.snapshot();
        Synonyms.Version next = current;
        Path file = synonymsFile();
        try {
            Synonyms.Version prepared = Synonyms.prepareFromFile(file);
            if (prepared != null) {
                next = prepared;
            } else if (file.toString().equals(Synonyms.source())) {
                next = Synonyms.defaults();
            }
        } catch (IOException | RuntimeException e) {
            log.error("[knowledge] 同义词覆盖表加载失败，保留当前表：{}", file, e);
        }
        retriever.replace(chunks, next);
        Synonyms.Version active = Synonyms.snapshot();
        if (next != current) {
            active = Synonyms.activateIfUnchanged(current.generation(), next);
        }
        if (!active.table().equals(next.table()) || !active.source().equals(next.source())) {
            retriever.refreshSynonyms(active);
        }
        if (!retriever.list().isEmpty() && !retriever.stats().indexReady()) {
            throw new IllegalStateException("知识快照未就绪");
        }
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

    public Map<String, FileStat> byFile() {
        Map<String, FileStat> byFile = new LinkedHashMap<>();
        for (KnowledgeChunk chunk : chunks()) {
            FileStat previous = byFile.get(chunk.sourcePath());
            if (previous == null) {
                byFile.put(chunk.sourcePath(), new FileStat(chunk.title(), chunk.zone(), chunk.zoneTitle(), 1));
            } else {
                byFile.put(chunk.sourcePath(), new FileStat(previous.title(), previous.zone(), previous.zoneTitle(),
                        previous.chunks() + 1));
            }
        }
        return byFile;
    }

    @Scheduled(fixedDelay = 10_000L, initialDelay = 10_000L)
    public void watchTick() {
        if (!watchEnabled) {
            return;
        }
        String current;
        try {
            current = fingerprint();
        } catch (RuntimeException e) {
            log.error("[knowledge] 知识目录指纹遍历失败，跳过本次热更新", e);
            return;
        }
        if (current.equals(lastFingerprint)) {
            return;
        }
        try {
            int chunks = reload();
            log.info("[knowledge] 热更新重载完成：{} 个片段", chunks);
        } catch (RuntimeException e) {
            log.error("[knowledge] 热更新失败，保留上一代快照", e);
        }
    }

    private String fingerprintOrNull() {
        try {
            return fingerprint();
        } catch (RuntimeException e) {
            log.warn("[knowledge] 知识目录指纹获取失败：{}", e.getMessage());
            return null;
        }
    }

    private String stableFingerprint(String before, String phase) {
        String after = fingerprintOrNull();
        if (before != null && before.equals(after)) {
            return after;
        }
        log.warn("[knowledge] {}期间知识目录发生变化，将保留旧代并等待下一轮重载", phase);
        return null;
    }

    private String fingerprint() {
        try (Stream<Path> stream = Files.walk(knowledgeDir)) {
            return stream.filter(Files::isRegularFile)
                    .sorted(Comparator.comparing(Path::toString))
                    .map(path -> path + ":" + size(path) + ":" + modified(path))
                    .reduce("", (left, right) -> left + "|" + right);
        } catch (IOException | UncheckedIOException e) {
            throw new IllegalStateException("遍历知识目录失败：" + knowledgeDir, e);
        }
    }

    private static long size(Path path) {
        try {
            return Files.size(path);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static long modified(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public record FileStat(String title, String zone, String zoneTitle, int chunks) {
    }
}
