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
        /**
         * `/api/feedback` 的独立限流（次/分钟/IP）：接口无鉴权、写的是运营统计，
         * 配额比 /api/chat 严；两个桶各算各的，互不占用（见 AppConfig.feedbackRateLimiter）。
         */
        int feedbackRatePerMin,
        int answerCacheSize,
        int uncoveredLogSize,
        String adminToken,
        boolean requireAdminToken,
        boolean noHitLlm,
        long logMaxBytes,
        String logMessageMode,
        String corsOrigins,
        /**
         * 是否信任 `X-Forwarded-For` 作为限流键（默认 false）。
         *
         * <p>该头由客户端可写：采信它等于让调用方自己选限流桶。只有前面挂着自家反代、
         * 且反代会剥离同名头时才打开（见 {@code http/ClientIp}）。
         */
        boolean trustForwardedFor,
        String nodeEnv,
        Llm llm,
        Embed embed,
        Audio audio,
        /**
         * Prompt 外置（见 {@code rag/PromptStore}）：三个路径都留空 = 用打包内置文本
         * （classpath {@code resources/prompts/*.txt}）；填外部文件路径则覆盖对应文本，
         * 现场改措辞不必重编译。POST /api/knowledge/reload 时一并重读，读失败自动回退内置文本。
         */
        Prompt prompt) {

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
            long timeoutMs,
            /** 单请求向量化条数上限：不同 provider 不一样（云服务常见 10 或 32），超限会整个请求 400 */
            int batchSize) {
    }

    /**
     * 语音（TTS 播报 + ASR 识音）。
     *
     * <p>{@code baseUrl}/{@code apiKey} 留空时回落 {@code LLM_*}：小米 MiMo 的语音与对话是同一个网关、
     * 同一个 key，展厅常见部署不必重复填。{@code provider=none} 或没配 base-url 时语音整体不可用，
     * 前端退回浏览器内置播报，问答不受影响。
     */
    public record Audio(
            String provider,
            String baseUrl,
            String apiKey,
            /** 播报音色：mimo-v2.5-tts 支持 冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean/mimo_default */
            String voice,
            /** 音色风格指令（user 消息），只影响语气语速，不念出来 */
            String style,
            String ttsModel,
            String asrModel,
            /** auto / zh / en；展厅以中文为主，默认 zh 更稳（auto 偶有英文字母误判） */
            String asrLanguage,
            long timeoutMs,
            int maxRetries,
            long retryBaseMs,
            /** 单次合成的文本上限（前端按句切片后通常远小于它） */
            int maxChars,
            /** 录音上传上限（字节，指解码后的 WAV；前端限时录音后远小于它） */
            long maxUploadBytes,
            /** 合成结果缓存条数：展厅里同一个问题被反复问，命中缓存能省一次外部调用并把首句延迟降到 0 */
            int ttsCacheSize,
            /**
             * 合成结果缓存的单条字节上限。
             *
             * <p>按条数封顶挡不住「64 条 × 数 MB」：一次长文合成能出几 MB 音频，堆会被慢慢吃光。
             * 超过这条线的结果照常返回、只是不入缓存（展厅的回答按句切片后多在几十 KB，收益不受影响）。
             */
            long ttsCacheMaxBytes,
            /** 合成接口的独立限流（次/分钟）：一次提问会合成多句，配额要比 /api/chat 宽 */
            int synthRatePerMin) {
    }

    /**
     * Prompt 覆盖文件路径（全部留空 = classpath 默认）。
     *
     * @param systemPath     system prompt 覆盖文件（PROMPT_SYSTEM_PATH）
     * @param noHitHintPath  闸门未通过时给模型的「直说没有」指令覆盖文件（PROMPT_NO_HIT_HINT_PATH）
     * @param noHitReplyPath 闸门未通过时的固定拒答话术覆盖文件（PROMPT_NO_HIT_REPLY_PATH）
     */
    public record Prompt(
            String systemPath,
            String noHitHintPath,
            String noHitReplyPath) {
    }

    public String llmProvider() {
        return (llm == null || llm.provider() == null || llm.provider().isBlank()) ? "mock" : llm.provider().toLowerCase();
    }

    public String embedProvider() {
        return (embed == null || embed.provider() == null || embed.provider().isBlank())
                ? "bag" : embed.provider().toLowerCase();
    }

    /** 语音 provider：none = 未启用（前端退回浏览器内置播报） */
    public String audioProvider() {
        return (audio == null || audio.provider() == null || audio.provider().isBlank())
                ? "none" : audio.provider().toLowerCase();
    }

    /** 语音端点基址：没配就回落对话网关（MiMo 同一个 key 兼做 TTS/ASR） */
    public String audioBaseUrl() {
        if (audio != null && audio.baseUrl() != null && !audio.baseUrl().isBlank()) {
            return audio.baseUrl();
        }
        return llm == null || llm.baseUrl() == null ? "" : llm.baseUrl();
    }

    public String audioApiKey() {
        if (audio != null && audio.apiKey() != null && !audio.apiKey().isBlank()) {
            return audio.apiKey();
        }
        return llm == null || llm.apiKey() == null ? "" : llm.apiKey();
    }

    /** 语音是否可用：provider=mimo 且拿得到 base-url 和 api-key 才算数 */
    public boolean audioEnabled() {
        return audioProvider().equals("mimo") && !audioBaseUrl().isBlank() && !audioApiKey().isBlank();
    }

    public String audioVoice() {
        return (audio == null || audio.voice() == null || audio.voice().isBlank()) ? "冰糖" : audio.voice();
    }

    public int audioMaxChars() {
        return audio == null || audio.maxChars() <= 0 ? 300 : audio.maxChars();
    }

    public long audioMaxUploadBytes() {
        return audio == null || audio.maxUploadBytes() <= 0 ? 2 * 1024 * 1024 : audio.maxUploadBytes();
    }

    public int audioSynthRatePerMin() {
        return audio == null || audio.synthRatePerMin() <= 0 ? 60 : audio.synthRatePerMin();
    }

    public int audioTtsCacheSize() {
        return audio == null || audio.ttsCacheSize() <= 0 ? 64 : audio.ttsCacheSize();
    }

    public long audioTtsCacheMaxBytes() {
        return audio == null || audio.ttsCacheMaxBytes() <= 0 ? 512 * 1024 : audio.ttsCacheMaxBytes();
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
