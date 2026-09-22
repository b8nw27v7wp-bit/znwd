package com.znwd.hostess.http;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.znwd.hostess.config.AppProperties;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** HTTP 边界：限流、缓存、入参校验、CORS、日志脱敏、管理口令。 */
class HttpSupportTest {

    @Test
    void 滑动窗口限流达到上限后拒绝并给出等待秒数() {
        RateLimiter limiter = new RateLimiter(2, 60_000);
        assertNull(limiter.allow("1.2.3.4"));
        assertNull(limiter.allow("1.2.3.4"));
        Long wait = limiter.allow("1.2.3.4");
        assertNotNull(wait, "超过上限必须被拦");
        assertTrue(wait >= 1);
        assertNull(limiter.allow("5.6.7.8"), "不同 IP 互不影响");
    }

    @Test
    void 缓存淘汰最久未用且key含索引代数() {
        LruCache<String> cache = new LruCache<>(2);
        cache.put("a", "1");
        cache.put("b", "2");
        cache.get("a");
        cache.put("c", "3");
        assertEquals(2, cache.size());
        assertNull(cache.get("b"), "b 最久未用，应被淘汰");
        assertNotNull(cache.get("a"));

        String g1 = LruCache.answerCacheKey("光伏板怎么清洗", "mimo", 1);
        String g2 = LruCache.answerCacheKey("光伏板怎么清洗", "mimo", 2);
        assertFalse(g1.equals(g2), "reload 后不同代不得命中同一缓存");
        assertEquals(g1, LruCache.answerCacheKey("  光伏板怎么清洗 ", "mimo", 1), "key 归一化：trim");
        assertEquals(LruCache.answerCacheKey("HELLO", "mimo", 1), LruCache.answerCacheKey("hello", "mimo", 1),
                "key 归一化：忽略大小写");
        assertFalse(g1.equals(LruCache.answerCacheKey("光伏板怎么清洗", "other-model", 1)), "换模型不得命中旧缓存");
    }

    @Test
    void 入参非法一律收敛为可判定的原因码() {
        assertEquals(RequestParser.Reason.BODY_NOT_OBJECT, RequestParser.parseChatInput(null).reason());
        assertEquals(RequestParser.Reason.BODY_NOT_OBJECT, RequestParser.parseChatInput(List.of("x")).reason());
        assertEquals(RequestParser.Reason.MESSAGE_NOT_STRING,
                RequestParser.parseChatInput(Map.of("message", 123)).reason());
        assertEquals(RequestParser.Reason.MESSAGE_EMPTY,
                RequestParser.parseChatInput(Map.of("message", "   ")).reason());
        assertEquals("message is required",
                RequestParser.validationMessage(RequestParser.Reason.MESSAGE_EMPTY));
    }

    @Test
    void 超长问题被截断且会话ID剔除危险字符() {
        String longMessage = "问".repeat(2500);
        RequestParser.ParseResult parsed = RequestParser.parseChatInput(
                Map.of("message", longMessage, "sessionId", "s-1;drop table#/x"));
        assertTrue(parsed.ok());
        assertEquals(RequestParser.MESSAGE_MAX_CHARS, parsed.value().message().length());
        assertTrue(parsed.value().truncated());
        assertEquals("s-1droptablex", parsed.value().sessionId(), "只保留 A-Za-z0-9._-");
    }

    @Test
    void CORS默认只放行本地开发源() {
        assertNotNull(CorsPolicy.allowedOrigin("http://localhost:5173", List.of()));
        assertNotNull(CorsPolicy.allowedOrigin("http://127.0.0.1:8080", List.of()));
        assertNull(CorsPolicy.allowedOrigin("https://evil.example", List.of()));

        List<String> allow = List.of("https://exhibit.example");
        assertNotNull(CorsPolicy.allowedOrigin("https://exhibit.example", allow));
        assertNull(CorsPolicy.allowedOrigin("https://evil.example", allow));
        assertNotNull(CorsPolicy.allowedOrigin("https://evil.example", List.of("*")));
    }

    @Test
    void 日志默认hash只留20字前缀_避免把访客原话整段落盘() {
        String message = "展厅里可以拍照吗我很想知道答案顺便问问开放时间安排";
        Map<String, Object> fields = MessageLog.fields(message, false);
        String preview = (String) fields.get("messagePreview");
        assertEquals(message.length(), fields.get("messageLen"));
        assertTrue(preview.contains("#" + message.length() + "#"), "hash 模式带长度信息");
        assertFalse(preview.contains(message), "hash 模式不得落盘完整问题");
        assertTrue(preview.contains(message.substring(0, 20)), "保留 20 字前缀便于排查（与旧实现一致）");

        Map<String, Object> previewMode = MessageLog.fields(message, true);
        assertTrue(((String) previewMode.get("messagePreview")).startsWith(message));
        assertTrue(MessageLog.fields(null, false).isEmpty(), "空消息不产生日志字段");
    }

    private static final String LOOPBACK = "127.0.0.1";

    @Test
    void 管理口令_未配置时开发放行生产拒绝_配置后必须带对() {
        AdminGuardFixture dev = new AdminGuardFixture(null, false, "");
        com.znwd.hostess.web.AdminGuard.require(null, dev.props(), LOOPBACK);

        AdminGuardFixture prod = new AdminGuardFixture(null, true, "");
        assertThrowsApi(() -> com.znwd.hostess.web.AdminGuard.require(null, prod.props(), LOOPBACK));

        AdminGuardFixture secure = new AdminGuardFixture("secret", true, "");
        assertThrowsApi(() -> com.znwd.hostess.web.AdminGuard.require(null, secure.props(), LOOPBACK));
        assertThrowsApi(() -> com.znwd.hostess.web.AdminGuard.require("Bearer wrong", secure.props(), LOOPBACK));
        com.znwd.hostess.web.AdminGuard.require("Bearer secret", secure.props(), LOOPBACK);
    }

    @Test
    void 管理口令_NODE_ENV为生产时未配口令必须拒绝() {
        for (String env : new String[] {"production", "prod", "staging", "PRODUCTION"}) {
            AdminGuardFixture fixture = new AdminGuardFixture(null, false, env);
            assertThrowsApi(() -> com.znwd.hostess.web.AdminGuard.require(null, fixture.props(), LOOPBACK),
                    "NODE_ENV=" + env + " 时未配 ADMIN_TOKEN 不得静默开放");
        }
        for (String env : new String[] {"", "development", "test"}) {
            AdminGuardFixture fixture = new AdminGuardFixture(null, false, env);
            com.znwd.hostess.web.AdminGuard.require(null, fixture.props(), LOOPBACK);
        }
    }

    @Test
    void 管理口令_非本机回环访问时未配口令必须拒绝() {
        // 展厅最容易踩的组合：HOST=0.0.0.0 暴露到局域网 + 忘配 ADMIN_TOKEN
        for (String addr : new String[] {"192.168.1.5", "10.0.0.12", "::ffff:192.168.1.5", "0.0.0.0"}) {
            AdminGuardFixture fixture = new AdminGuardFixture(null, false, "");
            assertThrowsApi(() -> com.znwd.hostess.web.AdminGuard.require(null, fixture.props(), addr),
                    "请求来自 " + addr + " 时不得放行");
        }
        // 拿不到地址按非本机处理（宁可多要一次口令，也不能默认开放）
        for (String addr : new String[] {null, "", "   "}) {
            AdminGuardFixture fixture = new AdminGuardFixture(null, false, "");
            assertThrowsApi(() -> com.znwd.hostess.web.AdminGuard.require(null, fixture.props(), addr),
                    "地址缺失时不得放行");
        }
    }

    @Test
    void 管理口令_本机回环访问时开发放行() {
        for (String addr : new String[] {"127.0.0.1", "127.0.1.1", "::1", "0:0:0:0:0:0:0:1", "localhost"}) {
            AdminGuardFixture fixture = new AdminGuardFixture(null, false, "");
            com.znwd.hostess.web.AdminGuard.require(null, fixture.props(), addr);
        }
    }

    @Test
    void 管理口令_配了口令后本机也必须带对() {
        AdminGuardFixture fixture = new AdminGuardFixture("secret", false, "");
        assertThrowsApi(() -> com.znwd.hostess.web.AdminGuard.require(null, fixture.props(), LOOPBACK));
        assertThrowsApi(() -> com.znwd.hostess.web.AdminGuard.require("Bearer wrong", fixture.props(), LOOPBACK));
        com.znwd.hostess.web.AdminGuard.require("Bearer secret", fixture.props(), LOOPBACK);
    }

    @Test
    void 健康接口上报的口令要求与守卫判据一致() {
        AdminGuardFixture dev = new AdminGuardFixture(null, false, "");
        assertFalse(com.znwd.hostess.web.AdminGuard.tokenRequiredNow(dev.props(), LOOPBACK));
        assertTrue(com.znwd.hostess.web.AdminGuard.tokenRequiredNow(dev.props(), "192.168.1.5"));

        AdminGuardFixture prod = new AdminGuardFixture(null, false, "production");
        assertTrue(com.znwd.hostess.web.AdminGuard.tokenRequiredNow(prod.props(), LOOPBACK));
    }

    private static void assertThrowsApi(Runnable action) {
        assertThrowsApi(action, "应当抛出 unauthorized");
    }

    private static void assertThrowsApi(Runnable action, String message) {
        try {
            action.run();
            throw new AssertionError(message);
        } catch (com.znwd.hostess.web.ApiException e) {
            assertEquals(com.znwd.hostess.http.ApiError.UNAUTHORIZED, e.code());
        }
    }

    /** 构造只改口令相关字段的配置对象（其余保持默认） */
    private record AdminGuardFixture(String token, boolean requireToken, String nodeEnv) {
        AppProperties props() {
            return new AppProperties("./knowledge", "./server/indexes", "./server/data", false, 3.8, 0.35, 30, 200,
                    50, token, requireToken, false, 5_000_000, "hash", "", false, nodeEnv,
                    new AppProperties.Llm("mock", "", "", "", 90_000, 180_000, 2, 1000, 0, ""),
                    new AppProperties.Embed("bag", "", "", "", 0, 512, 60_000));
        }
    }
}
