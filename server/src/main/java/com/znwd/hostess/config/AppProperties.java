package com.znwd.hostess.config;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 全部业务配置（单一来源）。
 *
 * <p>约定：服务、评测、标定三个入口都从这里取参数，禁止任何入口自己读 env 或直接用代码默认值——
 * 老版本的教训是「评测通过、线上跑的是另一套阈值」，排查时最费时间。
 */
@ConfigurationProperties(prefix = "znwd")
public record AppProperties(
        String knowledgeDir,
        String indexDir,
        String dataDir,
        boolean watchKnowledge,
        double minRelevanceScore,
        double minVectorScore,
        int chatRatePerMin,
        int answerCacheSize,
        int uncoveredLogSize,
        String adminToken,
        boolean requireAdminToken,
        boolean noHitLlm,
        long logMaxBytes,
        String logMessageMode,
        String corsOrigins,
        String nodeEnv,
        Llm llm,
        Embed embed) {

    public record Llm(
            String provider,
            String baseUrl,
            String apiKey,
            String model,
            long timeoutMs,
            long streamTimeoutMs,
            int maxRetries,
            long retryBaseMs,
            int maxTokens,
            String extraBody) {
    }

    public record Embed(
            String provider,
            String baseUrl,
            String apiKey,
            String model,
            int dims,
            int bagDims,
            long timeoutMs) {
    }

    public String llmProvider() {
        return (llm == null || llm.provider() == null || llm.provider().isBlank()) ? "mock" : llm.provider().toLowerCase();
    }

    public String embedProvider() {
        return (embed == null || embed.provider() == null || embed.provider().isBlank())
                ? "bag" : embed.provider().toLowerCase();
    }

    /** 管理口令；空串按未配置处理 */
    public String adminTokenOrNull() {
        return adminToken == null || adminToken.isBlank() ? null : adminToken;
    }

    /** 生产/预发（或显式开关）时管理接口必须带口令 */
    public boolean adminTokenRequired() {
        if (requireAdminToken) {
            return true;
        }
        String env = nodeEnv == null ? "" : nodeEnv.toLowerCase();
        return env.equals("production") || env.equals("prod") || env.equals("staging");
    }

    public List<String> corsOriginList() {
        if (corsOrigins == null || corsOrigins.isBlank()) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String part : corsOrigins.split("[,\\s]+")) {
            String trimmed = part.strip().replaceAll("/$", "");
            if (!trimmed.isEmpty()) {
                out.add(trimmed);
            }
        }
        return out;
    }

    public boolean logMessagePreviewMode() {
        return logMessageMode != null && logMessageMode.equalsIgnoreCase("preview");
    }

    /**
     * 知识目录解析：既支持「在仓库根启动」，也支持「在 server/ 里 mvn spring-boot:run」。
     * 判据是目录里有没有 _meta/zones.json —— 猜错目录会让检索悄悄变空，这种问题比报错更难查。
     */
    public Path knowledgeDirPath() {
        return resolve(knowledgeDir == null ? "./knowledge" : knowledgeDir, true, 3);
    }

    /**
     * 索引/数据目录一律锚定到仓库根。
     *
     * <p>踩过的坑：默认值写成 {@code ./server/indexes} 时，只有在仓库根启动才对；在 server/ 里启动会
     * 解析成 {@code server/server/indexes}（且被自动创建），于是「换个目录启动就换了一份索引」。
     */
    public Path indexDirPath() {
        return underRepoRoot(indexDir == null ? "server/indexes" : indexDir);
    }

    public Path dataDirPath() {
        return underRepoRoot(dataDir == null ? "server/data" : dataDir);
    }

    /** 仓库根：往上找到带 knowledge/_meta/zones.json 的那层；找不到就退回当前目录 */
    public static Path repoRoot() {
        Path base = Path.of("").toAbsolutePath();
        for (int i = 0; i <= 4 && base != null; i++) {
            if (Files.isRegularFile(base.resolve("knowledge").resolve("_meta").resolve("zones.json"))) {
                return base;
            }
            base = base.getParent();
        }
        return Path.of("").toAbsolutePath();
    }

    private static Path underRepoRoot(String raw) {
        Path path = Path.of(raw);
        return path.isAbsolute() ? path.normalize() : repoRoot().resolve(path).normalize();
    }

    private static Path resolve(String raw, boolean requireMarker, int maxLevels) {
        Path direct = Path.of(raw);
        if (direct.isAbsolute()) {
            return direct.normalize();
        }
        Path base = Path.of("").toAbsolutePath();
        for (int i = 0; i <= maxLevels && base != null; i++) {
            Path candidate = base.resolve(raw).normalize();
            if (requireMarker ? Files.isRegularFile(candidate.resolve("_meta").resolve("zones.json")) : Files.isDirectory(candidate)) {
                return candidate;
            }
            base = base.getParent();
        }
        return Path.of("").toAbsolutePath().resolve(raw).normalize();
    }
}
