package com.znwd.hostess.config;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.audio.DisabledSpeechModel;
import com.znwd.hostess.audio.MimoSpeechModel;
import com.znwd.hostess.audio.SpeechModel;
import com.znwd.hostess.embedding.BagEmbeddingProvider;
import com.znwd.hostess.embedding.EmbeddingProvider;
import com.znwd.hostess.embedding.OpenAiCompatEmbeddingProvider;
import com.znwd.hostess.knowledge.HybridRetriever;
import com.znwd.hostess.knowledge.KnowledgeLoader;
import com.znwd.hostess.knowledge.VectorStore;
import com.znwd.hostess.llm.ChatModel;
import com.znwd.hostess.llm.MockChatModel;
import com.znwd.hostess.llm.OpenAiCompatChatModel;
import com.znwd.hostess.rag.PromptStore;

/**
 * 核心组件装配：向量化 provider、向量索引、混合检索器、对话模型。
 *
 * <p>装配规则与原 Node 版一致：EMBED_* 未配置时回落 LLM_*（同一个网关既能对话也能做 embedding 的常见情形）；
 * provider 名写错直接启动失败，而不是悄悄退化成 mock——展厅演示时「以为接了模型其实是假回答」是最坏的情况。
 */
@Configuration
public class CoreConfig {

    private static final Logger log = LoggerFactory.getLogger(CoreConfig.class);

    @Bean
    public EmbeddingProvider embeddingProvider(AppProperties props, ObjectMapper mapper) {
        String provider = props.embedProvider();
        if (provider.equals("openai_compat")) {
            AppProperties.Embed embed = props.embed();
            String baseUrl = firstNonBlank(embed.baseUrl(), props.llm().baseUrl());
            String apiKey = firstNonBlank(embed.apiKey(), props.llm().apiKey());
            if (isBlank(embed.baseUrl())) {
                // 回落到 LLM_BASE_URL 是老行为（同一个网关既对话又做 embedding），但现在的对话网关
                // （小米 MiMo）并没有 embedding 模型：回落过去只会拿到 404，所以必须喊出来。
                log.warn("[embed] 未配置 EMBED_BASE_URL，回落到 LLM_BASE_URL={}（若该网关没有 embeddings 接口，"
                        + "向量构建会失败并退化为仅关键词）", baseUrl);
            }
            log.info("[embed] provider=openai_compat model={} dims={} batch={} baseUrl={}",
                    embed.model(), embed.dims(), embed.batchSize(), baseUrl);
            return new OpenAiCompatEmbeddingProvider(baseUrl, apiKey, embed.model(), embed.dims(),
                    Duration.ofMillis(embed.timeoutMs()), mapper);
        }
        if (!provider.equals("bag")) {
            throw new IllegalStateException("Unknown EMBED_PROVIDER: " + provider + " (bag | openai_compat)");
        }
        log.info("[embed] provider=bag dims={} （特征哈希兜底，非语义向量）", props.embed().bagDims());
        return new BagEmbeddingProvider(props.embed().bagDims());
    }

    @Bean
    public VectorStore vectorStore(EmbeddingProvider embedder, AppProperties props, ObjectMapper mapper) {
        return new VectorStore(embedder, props.indexDirPath().resolve("vectors." + embedder.name() + ".json"), mapper,
                props.embed() == null ? 32 : props.embed().batchSize());
    }

    @Bean
    public HybridRetriever hybridRetriever(VectorStore vectorStore, AppProperties props) {
        return new HybridRetriever(vectorStore, props.minRelevanceScore(), props.minVectorScore());
    }

    /**
     * Prompt 文本仓库：classpath 默认 + 外部文件覆盖。问答与知识热更新共用同一个实例，
     * 知识 reload 时顺带重读（见 KnowledgeService.reload）。
     */
    @Bean
    public PromptStore promptStore(AppProperties props) {
        return new PromptStore(props.prompt());
    }

    /** 启动时把知识灌进检索器（gen=1），与原版 index.ts 的启动序列一致 */
    @Bean
    public KnowledgeService knowledgeService(
            KnowledgeLoader loader, HybridRetriever retriever, VectorStore vectorStore, AppProperties props,
            PromptStore prompts) {
        return new KnowledgeService(loader, retriever, vectorStore, props.knowledgeDirPath(), props.watchKnowledge(),
                prompts);
    }

    @Bean
    @Primary
    public ChatModel chatModel(AppProperties props, ObjectMapper mapper) {
        String provider = props.llmProvider();
        if (provider.equals("openai_compat")) {
            AppProperties.Llm llm = props.llm();
            log.info("[llm] provider=openai_compat model={} base={} maxTokens={}", llm.model(), llm.baseUrl(), llm.maxTokens());
            return new OpenAiCompatChatModel(llm.baseUrl(), llm.apiKey(), llm.model(), llm.timeoutMs(),
                    llm.streamTimeoutMs(), llm.maxRetries(), llm.retryBaseMs(), llm.maxTokens(),
                    parseExtraBody(llm.extraBody(), mapper), mapper);
        }
        if (!provider.equals("mock")) {
            throw new IllegalStateException("Unknown LLM_PROVIDER: " + provider + " (mock | openai_compat)");
        }
        log.info("[llm] provider=mock （离线演示模型）");
        return new MockChatModel();
    }

    /**
     * 语音（TTS 播报 + ASR 识音）。
     *
     * <p>未启用时给一个「明确不可用」的占位实现而不是 null：路由层据此回 503，前端据此降级到
     * 浏览器内置播报；留 null 会让每处调用都多一个判空分支，漏一处就是 500。
     */
    @Bean
    public SpeechModel speechModel(AppProperties props, ObjectMapper mapper) {
        String provider = props.audioProvider();
        if (provider.equals("none")) {
            log.info("[audio] 语音未启用（AUDIO_PROVIDER=none）→ /api/speech/* 返回 503，前端走浏览器内置播报");
            return new DisabledSpeechModel("语音未启用（AUDIO_PROVIDER=none）");
        }
        if (!provider.equals("mimo")) {
            throw new IllegalStateException("Unknown AUDIO_PROVIDER: " + provider + " (none | mimo)");
        }
        if (props.audioBaseUrl().isBlank()) {
            log.warn("[audio] AUDIO_PROVIDER=mimo 但拿不到 base-url（AUDIO_BASE_URL 与 LLM_BASE_URL 都为空），"
                    + "语音不可用，前端走浏览器内置播报");
            return new DisabledSpeechModel("语音缺少 base-url");
        }
        if (props.audioApiKey().isBlank()) {
            log.warn("[audio] AUDIO_PROVIDER=mimo 但拿不到 api-key（AUDIO_API_KEY 与 LLM_API_KEY 都为空），"
                    + "语音不可用，前端走浏览器内置播报");
            return new DisabledSpeechModel("语音缺少 api-key");
        }
        AppProperties.Audio audio = props.audio();
        log.info("[audio] provider=mimo tts={} asr={} voice={} lang={} baseUrl={} 预算 tts={}ms asr={}ms",
                audio.ttsModel(), audio.asrModel(), props.audioVoice(), audio.asrLanguage(), props.audioBaseUrl(),
                props.audioTimeoutMs(), props.audioAsrTimeoutMs());
        return new MimoSpeechModel(props.audioBaseUrl(), props.audioApiKey(), audio.ttsModel(), props.audioVoice(),
                audio.style(), audio.asrModel(), audio.asrLanguage(), props.audioTimeoutMs(), props.audioAsrTimeoutMs(),
                audio.maxRetries(), audio.retryBaseMs(), mapper);
    }

    /** LLM_EXTRA_BODY：JSON 合并进请求体（MiMo 必须靠它关 thinking 模式） */
    static Map<String, Object> parseExtraBody(String raw, ObjectMapper mapper) {
        if (raw == null || raw.isBlank()) {
            return Map.of();
        }
        try {
            Map<String, Object> parsed = mapper.readValue(raw, new TypeReference<LinkedHashMap<String, Object>>() {
            });
            if (parsed == null) {
                return Map.of();
            }
            log.info("[llm] LLM_EXTRA_BODY 生效：{}", parsed.keySet());
            return parsed;
        } catch (Exception e) {
            log.warn("[llm] LLM_EXTRA_BODY 必须是 JSON 对象，已忽略：{}", e.getMessage());
            return Map.of();
        }
    }

    private static String firstNonBlank(String a, String b) {
        return a == null || a.isBlank() ? (b == null ? "" : b) : a;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
