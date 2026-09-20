package com.znwd.hostess.web;

import java.io.IOException;
import java.io.InputStream;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.analytics.Analytics;
import com.znwd.hostess.config.AppProperties;
import com.znwd.hostess.config.KnowledgeService;
import com.znwd.hostess.http.LruCache;
import com.znwd.hostess.knowledge.Suggestions;
import com.znwd.hostess.knowledge.VectorStore;
import com.znwd.hostess.repository.DatabaseStatus;
import com.znwd.hostess.session.SessionStore;

/** 运行状态与展区元数据：/api/health、/api/suggestions、/api/zones、/api/openapi.json。 */
@RestController
public class StatusController {

    public static final String VERSION = "1.2.0";

    private final KnowledgeService knowledge;
    private final VectorStore vectorStore;
    private final SessionStore sessions;
    private final Analytics analytics;
    private final LruCache<LruCache.CachedAnswer> cache;
    private final AppProperties props;
    private final ObjectMapper mapper;
    private final DatabaseStatus databaseStatus;
    private final long startedAt = ManagementFactory.getRuntimeMXBean().getStartTime();

    public StatusController(KnowledgeService knowledge, VectorStore vectorStore, SessionStore sessions,
                            Analytics analytics, LruCache<LruCache.CachedAnswer> cache, AppProperties props,
                            ObjectMapper mapper, DatabaseStatus databaseStatus) {
        this.knowledge = knowledge;
        this.vectorStore = vectorStore;
        this.sessions = sessions;
        this.analytics = analytics;
        this.cache = cache;
        this.props = props;
        this.mapper = mapper;
        this.databaseStatus = databaseStatus;
    }

    @GetMapping("/api/health")
    public Map<String, Object> health(HttpServletRequest request) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("version", VERSION);
        out.put("knowledgeChunks", knowledge.chunks().size());
        out.put("llmProvider", props.llmProvider());
        out.put("embedding", vectorStore.stats().provider());
        out.put("retrieval", knowledge.stats());
        out.put("knowledgeDir", knowledge.knowledgeDir().toString());
        out.put("activeSessions", sessions.count());
        out.put("answerCacheSize", cache.size());
        out.put("dataDir", props.dataDirPath().toString());
        out.put("watchKnowledge", knowledge.watchEnabled());
        out.put("adminTokenRequired", props.adminTokenRequired());
        out.put("corsOrigins", props.corsOriginList());
        out.put("minRelevanceScore", props.minRelevanceScore());
        out.put("noHitLlm", props.noHitLlm());
        // 存储从「可选文件持久化」升级为 MySQL（会话/统计/反馈重启不丢）
        out.put("storage", "mysql");
        out.put("storageAvailable", databaseStatus.available());
        out.put("host", request.getServerName() + ":" + request.getServerPort());
        out.put("uptimeSec", (System.currentTimeMillis() - startedAt) / 1000);
        return out;
    }

    @GetMapping("/api/suggestions")
    public Map<String, Object> suggestions(@RequestParam(value = "zone", required = false) String zone) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", Suggestions.forZone(knowledge.zonesMeta(), zone));
        out.put("zone", zone);
        return out;
    }

    @GetMapping("/api/zones")
    public Map<String, Object> zones() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("zones", knowledge.zonesMeta().zones());
        List<Map<String, Object>> media = knowledge.zonesMeta().media().stream()
                .map(m -> Map.<String, Object>of("mediaId", m.mediaId(), "title", m.title(), "zoneId", m.zoneId()))
                .toList();
        out.put("media", media);
        return out;
    }

    /** API 契约：从 classpath 资源读，改契约改文件即可，别在 Java 里手拼大段 JSON */
    @GetMapping("/api/openapi.json")
    public Map<String, Object> openapi() {
        try (InputStream in = getClass().getResourceAsStream("/openapi.json")) {
            if (in == null) {
                throw new ApiException(org.springframework.http.HttpStatus.INTERNAL_SERVER_ERROR,
                        com.znwd.hostess.http.ApiError.INTERNAL_ERROR, "openapi.json 缺失");
            }
            String raw = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            return mapper.readValue(raw, new com.fasterxml.jackson.core.type.TypeReference<LinkedHashMap<String, Object>>() {
            });
        } catch (IOException e) {
            throw new ApiException(org.springframework.http.HttpStatus.INTERNAL_SERVER_ERROR,
                    com.znwd.hostess.http.ApiError.INTERNAL_ERROR, "openapi.json 读取失败");
        }
    }

    /** 供内部/运维快速核对统计（与 /api/stats 不同的是这里不校验口令，只暴露零敏感信息） */
    @GetMapping("/api/health/summary")
    public Map<String, Object> summary() {
        Map<String, Object> stats = analytics.stats(sessions.count());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("chatTotal", stats.get("chatTotal"));
        out.put("noHit", stats.get("noHit"));
        out.put("activeSessions", stats.get("activeSessions"));
        out.put("retrieval", knowledge.stats().mode());
        return out;
    }
}
