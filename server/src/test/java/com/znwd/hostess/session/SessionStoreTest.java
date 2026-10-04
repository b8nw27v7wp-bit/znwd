package com.znwd.hostess.session;

import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

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
    // 会话归属令牌 issueTokenOnce / mayAccess
    // ══════════════════════════════════════════════════════════════

    /**
     * 令牌生命周期：创建后首次交付 → 匹配 → 不匹配 → reset 后消失。
     *
     * <p>关键语义（P0-2）：**一个会话至多交付一次**。老实现每次调用都把同一枚令牌再给一遍，
     * 于是拿着共用大屏 localStorage 里的 sessionId 再问一句，就能把上一位访客的令牌换出来。
     */
    @Test
    void 令牌生命周期() {
        SessionStore store = new SessionStore(null, null);
        store.append("s1", "问", "答");

        String token = store.issueTokenOnce("s1");
        assertNotNull(token, "会话创建后的首次调用应交付令牌");
        assertFalse(token.isEmpty());
        assertNull(store.issueTokenOnce("s1"), "一个会话至多下发一次：再次问答拿不到令牌");
        assertNull(store.issueTokenOnce("s1"), "之后每次问答都拿不到");

        assertTrue(store.mayAccess("s1", token), "匹配令牌应放行");
        assertFalse(store.mayAccess("s1", "wrong"), "不匹配令牌应拒绝");
        assertFalse(store.mayAccess("s1", null), "null 令牌应拒绝");

        assertTrue(store.reset("s1"));
        assertNull(store.issueTokenOnce("s1"), "reset 后会话不存在，无令牌可发");
        // reset 后会话不存在，mayAccess 按向后兼容语义返回 true
        assertTrue(store.mayAccess("s1", token),
                "reset 后会话不存在，mayAccess 返回 true（向后兼容）");
    }

    /**
     * 令牌不再下发 ≠ 旧令牌作废：前端就是拿**第一次**拿到的那枚令牌去 GET/DELETE 的，
     * 之后的问答响应不再带令牌，但读会话必须照旧放行。
     */
    @Test
    void 持旧令牌在令牌不再下发之后仍可读会话() {
        SessionStore store = new SessionStore(null, null);
        store.append("s1", "问", "答");

        String oldToken = store.issueTokenOnce("s1");
        assertNotNull(oldToken);
        assertNull(store.issueTokenOnce("s1"), "第二次问答拿不到令牌（只持 sessionId 不够）");

        assertTrue(store.mayAccess("s1", oldToken), "GET 带旧令牌仍要能读");
        assertFalse(store.mayAccess("s1", "stolen"), "拿错令牌照样拒绝");
    }

    /**
     * 重启恢复的老会话：令牌在内存里铸好但**从不下发**，于是
     * ① 拿 sessionId 换不到令牌 ② 没有令牌读历史一律拒绝——
     * 老实现的「entry.token == null 就放行」是条后门，等于无凭证可读历史。
     */
    @Test
    void 恢复的老会话换不到令牌也读不走历史() {
        long activeLastActive = System.currentTimeMillis() - 5_000;
        SessionMapper mapper = fakeMapper(
                List.of(new SessionMapper.SessionRow("restored-s", 2000L, activeLastActive)),
                id -> List.of(new SessionMapper.MessageRow(0, "user", "重启前问")));
        SessionStore store = new SessionStore(mapper, null);
        assertEquals(1, store.restore());

        assertNotNull(store.peek("restored-s"), "恢复的会话在内存里（历史仍在，只是不对 API 开放）");
        assertNull(store.issueTokenOnce("restored-s"), "恢复的老会话不得再下发令牌");
        assertFalse(store.mayAccess("restored-s", null), "无令牌读历史 → 拒绝");
        assertFalse(store.mayAccess("restored-s", "anything"), "随便给个令牌也拒绝");
    }

    // ══════════════════════════════════════════════════════════════
    // restore 与日常读写的并发（P1-7：查库在锁外）
    // ══════════════════════════════════════════════════════════════

    /**
     * restore() 的慢查询（deleteExpired + recentSessions + 每会话 messages）期间，
     * append/history/peek 不得被挡住，合并完成后也不能冲掉并发写入的会话。
     *
     * <p>老实现整段 {@code synchronized}，这条用例会在 {@code write.get(3s)} 处超时失败，
     * 而不是挂死——故意用超时判据，让「锁内 I/O」这类退化表现为明确的失败信息。
     */
    @Test
    void restore查库期间不阻塞读写且合并不丢并发会话() throws Exception {
        CountDownLatch inDbCall = new CountDownLatch(1);
        CountDownLatch releaseDbCall = new CountDownLatch(1);
        SessionMapper mapper = blockingMapper(
                List.of(new SessionMapper.SessionRow("db-s", 1000L, System.currentTimeMillis() - 1_000)),
                id -> List.of(new SessionMapper.MessageRow(0, "user", "重启前问")),
                inDbCall, releaseDbCall);
        SessionStore store = new SessionStore(mapper, null);

        Thread restorer = new Thread(store::restore, "restore");
        ExecutorService writers = Executors.newSingleThreadExecutor();
        restorer.start();
        try {
            assertTrue(inDbCall.await(2, TimeUnit.SECONDS), "restore 应已进入查库阶段");
            Future<?> write = writers.submit(() -> store.append("live-s", "并发问", "并发答"));
            try {
                write.get(3, TimeUnit.SECONDS);
            } catch (java.util.concurrent.TimeoutException e) {
                fail("restore 查库期间 append 被锁挡住（查库不该在全局锁里做）");
            }
            assertNotNull(store.peek("live-s"), "查库期间 peek/history 也要可用");
            assertEquals(2, store.history("live-s").size(), "并发写入的问/答当场可读");
        } finally {
            releaseDbCall.countDown();
            writers.shutdownNow();
            restorer.join(5_000);
        }

        assertFalse(restorer.isAlive(), "restore 应正常结束");
        assertEquals(2, store.count(), "库里恢复的 1 条 + 并发写入的 1 条都要在");
        assertNotNull(store.peek("db-s"), "恢复的会话要进来");
        assertNotNull(store.peek("live-s"), "合并不得冲掉恢复期间并发写入的会话");
        assertEquals("并发答", store.history("live-s").get(1).content());
    }

    // ══════════════════════════════════════════════════════════════
    // 边界：null sessionId
    // ══════════════════════════════════════════════════════════════

    @Test
    void null会话ID安全处理() {
        SessionStore store = new SessionStore(null, null);

        assertNull(store.peek(null));
        assertTrue(store.history(null).isEmpty());
        assertNull(store.issueTokenOnce(null));
        assertFalse(store.mayAccess(null, "tok"));
        assertFalse(store.reset(null));
        assertEquals(0, store.count());
    }

    // ── helpers ──────────────────────────────────────────────────

    private static SessionMapper fakeMapper(
            List<SessionMapper.SessionRow> rows,
            java.util.function.Function<String, List<SessionMapper.MessageRow>> msgProvider) {
        return mapperProxy((method, args) -> {
            if (method.getName().equals("recentSessions")) {
                return rows;
            }
            if (method.getName().equals("messages")) {
                return msgProvider.apply((String) args[0]);
            }
            return null;
        });
    }

    /** 查库阶段卡在 recentSessions 上（发信号后等待放行）：用来制造「restore 正在做慢 I/O」的窗口 */
    private static SessionMapper blockingMapper(
            List<SessionMapper.SessionRow> rows,
            java.util.function.Function<String, List<SessionMapper.MessageRow>> msgProvider,
            CountDownLatch inDbCall, CountDownLatch releaseDbCall) {
        return mapperProxy((method, args) -> {
            if (method.getName().equals("recentSessions")) {
                inDbCall.countDown();
                try {
                    if (!releaseDbCall.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("测试放行信号超时");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(e);
                }
                return rows;
            }
            if (method.getName().equals("messages")) {
                return msgProvider.apply((String) args[0]);
            }
            return null;
        });
    }

    private static SessionMapper mapperProxy(Body body) {
        return (SessionMapper) Proxy.newProxyInstance(
                SessionMapper.class.getClassLoader(),
                new Class<?>[]{SessionMapper.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("toString")) {
                        return "FakeSessionMapper";
                    }
                    Object value = body.invoke(method, args);
                    if (value == null && method.getReturnType() == int.class) {
                        return 0;
                    }
                    return value;
                });
    }

    @FunctionalInterface
    private interface Body {
        Object invoke(java.lang.reflect.Method method, Object[] args) throws Throwable;
    }
}
