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

import com.znwd.hostess.embedding.BagEmbeddingProvider;
import com.znwd.hostess.embedding.EmbeddingProvider;
import com.znwd.hostess.embedding.OpenAiCompatEmbeddingProvider;
import com.znwd.hostess.knowledge.HybridRetriever;
import com.znwd.hostess.knowledge.KnowledgeLoader;
import com.znwd.hostess.knowledge.VectorStore;
import com.znwd.hostess.llm.ChatModel;
import com.znwd.hostess.llm.MockChatModel;
import com.znwd.hostess.llm.OpenAiCompatChatModel;

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
            log.info("[embed] provider=openai_compat model={} dims={}", embed.model(), embed.dims());
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
        return new VectorStore(embedder, props.indexDirPath().resolve("vectors." + embedder.name() + ".json"), mapper);
    }

    @Bean
    public HybridRetriever hybridRetriever(VectorStore vectorStore, AppProperties props) {
        return new HybridRetriever(vectorStore, props.minRelevanceScore(), props.minVectorScore());
    }

    /** 启动时把知识灌进检索器（gen=1），与原版 index.ts 的启动序列一致 */
    @Bean
    public KnowledgeService knowledgeService(
            KnowledgeLoader loader, HybridRetriever retriever, VectorStore vectorStore, AppProperties props) {
        return new KnowledgeService(loader, retriever, vectorStore, props.knowledgeDirPath(), props.watchKnowledge());
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
}
