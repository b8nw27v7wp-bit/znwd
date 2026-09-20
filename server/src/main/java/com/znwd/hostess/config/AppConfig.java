package com.znwd.hostess.config;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.analytics.Analytics;
import com.znwd.hostess.http.JsonlStore;
import com.znwd.hostess.http.LruCache;
import com.znwd.hostess.http.RateLimiter;
import com.znwd.hostess.llm.ChatModel;
import com.znwd.hostess.rag.ChatRunService;
import com.znwd.hostess.repository.ChatLogMapper;
import com.znwd.hostess.repository.DatabaseStatus;
import com.znwd.hostess.repository.FeedbackMapper;
import com.znwd.hostess.repository.SessionMapper;
import com.znwd.hostess.repository.UncoveredMapper;
import com.znwd.hostess.session.SessionStore;

/**
 * 业务组件装配与启动序列。
 *
 * <p>启动顺序刻意明确：先灌知识 → 再恢复会话/统计 → 最后对外服务。反过来（先开监听再加载知识）
 * 会让重启瞬间的提问被闸门拦成「资料中没有」。
 */
@Configuration
public class AppConfig {

    private static final Logger log = LoggerFactory.getLogger(AppConfig.class);

    @Bean
    public SessionStore sessionStore(SessionMapper sessionMapper, DatabaseStatus databaseStatus) {
        return new SessionStore(sessionMapper, databaseStatus);
    }

    @Bean
    public Analytics analytics(ChatLogMapper chatLogMapper, FeedbackMapper feedbackMapper,
                               UncoveredMapper uncoveredMapper, DatabaseStatus databaseStatus,
                               AppProperties props) {
        return new Analytics(chatLogMapper, feedbackMapper, uncoveredMapper, databaseStatus, props.uncoveredLogSize());
    }

    @Bean
    public LruCache<LruCache.CachedAnswer> answerCache(AppProperties props) {
        return new LruCache<>(props.answerCacheSize());
    }

    @Bean
    public RateLimiter chatRateLimiter(AppProperties props) {
        return new RateLimiter(props.chatRatePerMin(), 60_000L);
    }

    @Bean
    public JsonlStore eventLog(AppProperties props, ObjectMapper mapper) {
        return new JsonlStore(props.dataDirPath(), "events", props.logMaxBytes(),
                props.logMessagePreviewMode(), mapper);
    }

    @Bean
    public ChatRunService chatRunService(KnowledgeService knowledge, ChatModel model, SessionStore sessions,
                                         Analytics analytics, LruCache<LruCache.CachedAnswer> cache,
                                         JsonlStore logStore, AppProperties props) {
        ChatRunService service = new ChatRunService(knowledge, model, sessions, analytics, cache, logStore,
                props.noHitLlm());
        return service;
    }

    /** 回答缓存必须绑在知识代上：reload 之后旧代答案不该再命中 */
    @Bean
    public StartupRunner startupRunner(KnowledgeService knowledge, SessionStore sessions, Analytics analytics,
                                       AppProperties props, JsonlStore logStore,
                                       LruCache<LruCache.CachedAnswer> answerCache, DatabaseStatus databaseStatus,
                                       RateLimiter chatRateLimiter) {
        return new StartupRunner(knowledge, sessions, analytics, props, logStore, answerCache, databaseStatus,
                chatRateLimiter);
    }

    public static class StartupRunner {

        private final KnowledgeService knowledge;
        private final SessionStore sessions;
        private final Analytics analytics;
        private final AppProperties props;
        private final JsonlStore logStore;
        private final LruCache<LruCache.CachedAnswer> answerCache;
        private final DatabaseStatus databaseStatus;
        private final RateLimiter rateLimiter;

        public StartupRunner(KnowledgeService knowledge, SessionStore sessions, Analytics analytics,
                             AppProperties props, JsonlStore logStore, LruCache<LruCache.CachedAnswer> answerCache,
                             DatabaseStatus databaseStatus, RateLimiter rateLimiter) {
            this.knowledge = knowledge;
            this.sessions = sessions;
            this.analytics = analytics;
            this.props = props;
            this.logStore = logStore;
            this.answerCache = answerCache;
            this.databaseStatus = databaseStatus;
            this.rateLimiter = rateLimiter;
        }

        @EventListener(ApplicationReadyEvent.class)
        public void onReady() {
            // 1) 知识：加载失败就直接抛，宁可起不来也不要拿空知识库对外服务
            knowledge.loadInitial();
            // 2) 数据库探活：连不上就明确降级（继续服务但不落库），别让运营以为"一切正常"
            if (databaseStatus.check()) {
                int restoredSessions = sessions.restore();
                int restoredFeedback = analytics.restore();
                log.info("[startup] MySQL 可用：恢复会话 {} 个、反馈 {} 条", restoredSessions, restoredFeedback);
            } else {
                log.warn("[startup] MySQL 不可用（{}）：本次运行不落库（会话/统计/反馈重启会丢），"
                        + "修复后重启即可恢复。检查 DB_USER/DB_PASSWORD 与 server/db/init.sql。",
                        databaseStatus.error());
            }
            // 3) 知识重载时清答案缓存：旧索引时代生成的答案不该继续命中
            knowledge.setOnReloaded(() -> {
                answerCache.clear();
                log.info("[knowledge] reload 完成，已清答案缓存，索引代数={}", knowledge.retriever().generation());
            });
            log.info("[startup] 就绪：chunks={} embed={} llm={} 阈值 kw={} vec={} adminRequired={} 限流={}/min CORS={}",
                    knowledge.chunks().size(), props.embedProvider(), props.llmProvider(),
                    props.minRelevanceScore(), props.minVectorScore(), props.adminTokenRequired(),
                    props.chatRatePerMin(), props.corsOriginList());
        }

        /** 定时清理：反馈与未覆盖清单的历史尾巴，并回收限流器的过期窗口 */
        @Scheduled(fixedDelay = 10 * 60 * 1000L, initialDelay = 10 * 60 * 1000L)
        public void housekeeping() {
            analytics.trimStorage(Analytics.MAX_FEEDBACK, Math.max(50, props.uncoveredLogSize()));
            rateLimiter.evictExpired();
        }

        @EventListener(ContextClosedEvent.class)
        public void onShutdown() {
            logStore.flush();
        }
    }
}
