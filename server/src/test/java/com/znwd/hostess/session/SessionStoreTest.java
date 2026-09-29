package com.znwd.hostess.session;

import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.znwd.hostess.llm.ChatMessage;
import com.znwd.hostess.llm.ChatRole;
import com.znwd.hostess.repository.SessionMapper;

import static org.junit.jupiter.api.Assertions.*;

/**
 * SessionStore 单元测试：TC-SES-04（TTL 过期）、TC-DGR-12（会话上限与轮次裁剪）。
 *
 * <p>不依赖真实 MySQL：mapper 用 JDK Proxy 做测试替身，或者直接传 null。
 * TTL_MS / MAX_SESSIONS 的断言用硬编码值（不引用常量），以便变异验证时能真失败。
 */
class SessionStoreTest {

    // ══════════════════════════════════════════════════════════════
    // TC-SES-04: TTL 过期
    // ══════════════════════════════════════════════════════════════

    /**
     * restore() 从 mapper 加载两条会话：一条 lastActive 已超 TTL，一条刚活跃。
     * 过期会话 peek/history 视为不存在；未过期会话可读；count 只计入存活会话。
     */
    @Test
    void restore加载的过期会话不可访问而活跃会话可读() {
        long now = System.currentTimeMillis();
        // 硬编码偏移量，不引用 SessionStore.TTL_MS，使变异验证可捕获
        long expiredLastActive = now - 600_001;   // 超过 10 分钟
        long activeLastActive = now - 5_000;      // 5 秒前，远在 TTL 内

        List<SessionMapper.SessionRow> rows = List.of(
                new SessionMapper.SessionRow("expired-s", 1000L, expiredLastActive),
                new SessionMapper.SessionRow("active-s", 2000L, activeLastActive));
        Map<String, List<SessionMapper.MessageRow>> msgs = Map.of(
                "expired-s", List.of(new SessionMapper.MessageRow(0, "user", "过期问")),
                "active-s", List.of(new SessionMapper.MessageRow(0, "user", "活跃问")));

        SessionMapper mapper = fakeMapper(rows, id -> msgs.getOrDefault(id, List.of()));
        SessionStore store = new SessionStore(mapper, null);
        int loaded = store.restore();

        assertEquals(2, loaded, "mapper 返回的两条都应被加载到内存");
        assertNull(store.peek("expired-s"), "过期会话 peek 应返回 null（GET 404 语义）");
        assertTrue(store.history("expired-s").isEmpty(), "过期会话 history 应为空");
        assertNotNull(store.peek("active-s"), "未过期会话 peek 应非 null");
        assertFalse(store.history("active-s").isEmpty(), "未过期会话 history 应有消息");
        assertEquals(1, store.count(), "count 只计入未过期会话");
    }

    // ══════════════════════════════════════════════════════════════
    // TC-DGR-12: 会话上限 MAX_SESSIONS
    // ══════════════════════════════════════════════════════════════

    /**
     * 不带 mapper，连续 append 201 个会话后 count 为 200，最旧会话被淘汰。
     */
    @Test
    void 超出上限时淘汰最旧会话且不影响新建() {
        SessionStore store = new SessionStore(null, null);

        for (int i = 0; i <= 200; i++) {
            store.append("s-" + String.format("%03d", i), "问" + i, "答" + i);
        }

        assertEquals(200, store.count(), "201 个会话后 count 应为 200");
        assertNull(store.peek("s-000"), "最旧（first-inserted）会话应被淘汰");
        assertNotNull(store.peek("s-200"), "最新会话应仍可访问");
    }

    // ══════════════════════════════════════════════════════════════
    // MAX_TURNS: 单会话轮次裁剪
    // ══════════════════════════════════════════════════════════════

    /**
     * 同一会话连问 10 轮后只保留最近 6 轮（12 条消息），顺序与内容正确。
     */
    @Test
    void 单会话超过六轮后只保留最近六轮且顺序正确() {
        SessionStore store = new SessionStore(null, null);

        for (int i = 0; i < 10; i++) {
            store.append("s1", "问" + i, "答" + i);
        }

        List<ChatMessage> history = store.history("s1");
        assertEquals(12, history.size(), "10 轮应裁剪到 6 轮（12 条消息）");

        assertEquals("问4", history.get(0).content(), "最早保留的是第 4 轮用户消息");
        assertEquals("答4", history.get(1).content(), "第 4 轮助手消息");
        assertEquals("问9", history.get(10).content(), "第 9 轮用户消息");
        assertEquals("答9", history.get(11).content(), "最后一轮助手消息");

        // 验证角色交替正确
        for (int i = 0; i < history.size(); i += 2) {
            assertEquals(ChatRole.USER, history.get(i).role(), "偶数位应为 USER");
            assertEquals(ChatRole.ASSISTANT, history.get(i + 1).role(), "奇数位应为 ASSISTANT");
        }
    }

    // ══════════════════════════════════════════════════════════════
    // 会话归属令牌 tokenFor / mayAccess
    // ══════════════════════════════════════════════════════════════

    /**
     * 令牌生命周期：生成 → 匹配 → 不匹配 → reset 后消失。
     */
    @Test
    void 令牌生命周期() {
        SessionStore store = new SessionStore(null, null);
        store.append("s1", "问", "答");

        String token = store.tokenFor("s1");
        assertNotNull(token, "首次 tokenFor 应生成令牌");
        assertFalse(token.isEmpty());
        assertEquals(token, store.tokenFor("s1"), "重复调用应返回同一令牌");

        assertTrue(store.mayAccess("s1", token), "匹配令牌应放行");
        assertFalse(store.mayAccess("s1", "wrong"), "不匹配令牌应拒绝");
        assertFalse(store.mayAccess("s1", null), "null 令牌应拒绝");

        assertTrue(store.reset("s1"));
        assertNull(store.tokenFor("s1"), "reset 后令牌消失");
        // reset 后会话不存在，mayAccess 按向后兼容语义返回 true
        assertTrue(store.mayAccess("s1", token),
                "reset 后会话不存在，mayAccess 返回 true（向后兼容）");
    }

    /**
     * 从未下发令牌的老会话：tokenFor 未调过，mayAccess 对所有调用方放行。
     */
    @Test
    void 从未下发令牌的老会话对所有调用方放行() {
        SessionStore store = new SessionStore(null, null);
        store.append("s1", "问", "答");
        // 不调 tokenFor → entry.token 保持 null

        assertTrue(store.mayAccess("s1", "anything"),
                "从未下发令牌的会话应允许任何 token");
        assertTrue(store.mayAccess("s1", null),
                "从未下发令牌的会话，null token 也应放行");
    }

    // ══════════════════════════════════════════════════════════════
    // 边界：null sessionId
    // ══════════════════════════════════════════════════════════════

    @Test
    void null会话ID安全处理() {
        SessionStore store = new SessionStore(null, null);

        assertNull(store.peek(null));
        assertTrue(store.history(null).isEmpty());
        assertNull(store.tokenFor(null));
        assertFalse(store.mayAccess(null, "tok"));
        assertFalse(store.reset(null));
        assertEquals(0, store.count());
    }

    // ── helpers ──────────────────────────────────────────────────

    private static SessionMapper fakeMapper(
            List<SessionMapper.SessionRow> rows,
            java.util.function.Function<String, List<SessionMapper.MessageRow>> msgProvider) {
        return (SessionMapper) Proxy.newProxyInstance(
                SessionMapper.class.getClassLoader(),
                new Class<?>[]{SessionMapper.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("recentSessions")) {
                        return rows;
                    }
                    if (method.getName().equals("messages")) {
                        return msgProvider.apply((String) args[0]);
                    }
                    if (method.getName().equals("toString")) {
                        return "FakeSessionMapper";
                    }
                    if (method.getReturnType() == int.class) {
                        return 0;
                    }
                    return null;
                });
    }
}
