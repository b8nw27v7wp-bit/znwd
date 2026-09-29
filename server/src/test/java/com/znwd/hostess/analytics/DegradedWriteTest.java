package com.znwd.hostess.analytics;

import java.lang.reflect.Proxy;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.Test;

import com.znwd.hostess.domain.ChatLogEntry;
import com.znwd.hostess.domain.FeedbackEntry;
import com.znwd.hostess.repository.ChatLogMapper;
import com.znwd.hostess.repository.DatabaseStatus;
import com.znwd.hostess.repository.FeedbackMapper;
import com.znwd.hostess.repository.HealthMapper;
import com.znwd.hostess.repository.SessionMapper;
import com.znwd.hostess.repository.UncoveredMapper;
import com.znwd.hostess.session.SessionStore;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 降级模式的写路径：库不可用时**不尝试写库**。
 *
 * <p>为什么值得单测：实测库挂掉时每次落库要白等 Hikari 的 connection-timeout（3 秒），
 * 展厅现场就是「问一句卡三秒」。守卫写在这里，改坏了不会有人立刻发现——只有真断库时才暴露。
 */
class DegradedWriteTest {

    /** 假状态：直接指定"能不能写"，绕开真 DataSource */
    private static class FakeDbStatus extends DatabaseStatus {
        private final boolean writable;

        FakeDbStatus(boolean writable) {
            super(null, null);
            this.writable = writable;
        }

        @Override
        public boolean shouldAttempt() {
            return writable;
        }
    }

    /**
     * 记录调用次数的 mapper 替身（MyBatis 接口用动态代理实现）。
     *
     * <p>返回值必须按真实返回类型给默认值：`trim` 返回 int，返回 null 会在拆箱时 NPE，
     * 而调用方（trimStorage）把异常 catch 掉了——表现是「只数到一条裁剪」，很容易看错。
     */
    @SuppressWarnings("unchecked")
    private static <T> T counting(Class<T> type, AtomicInteger counter) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, (proxy, method, args) -> {
            if (method.getName().equals("toString")) {
                return type.getSimpleName() + "Stub";
            }
            counter.incrementAndGet();
            Class<?> returnType = method.getReturnType();
            if (returnType == int.class) {
                return 0;
            }
            if (returnType == long.class) {
                return 0L;
            }
            if (returnType == boolean.class) {
                return false;
            }
            return null;
        });
    }

    private static ChatLogEntry chatLog() {
        return new ChatLogEntry(1L, "s1", "rag", "openai_compat", "问一句#7#问一句", 7, "答一句", 10L,
                false, "keyword", false, "叶片检测要停机吗？", null, null);
    }

    private static FeedbackEntry feedback() {
        return new FeedbackEntry(1L, "s1", "up", null, "问一句");
    }

    @Test
    void 库不可用时问答日志与反馈都不写库() {
        AtomicInteger writes = new AtomicInteger();
        Analytics analytics = new Analytics(
                counting(ChatLogMapper.class, writes), counting(FeedbackMapper.class, writes), null,
                new FakeDbStatus(false), 50);

        analytics.logChat(chatLog());
        analytics.logFeedback(feedback());

        assertEquals(0, writes.get(), "库不可用不应尝试写库（否则每次问答白等 connection-timeout）");
        // 内存统计照常：展厅讲解与运营视图不受影响
        assertEquals(1L, analytics.stats(1).get("chatTotal"), "内存统计照常（返回 long）");
    }

    @Test
    void 库不可用时定时裁剪不碰库() {
        AtomicInteger writes = new AtomicInteger();
        Analytics analytics = new Analytics(
                counting(ChatLogMapper.class, writes), counting(FeedbackMapper.class, writes),
                counting(UncoveredMapper.class, writes), new FakeDbStatus(false), 50);

        analytics.trimStorage(20, 50);

        assertEquals(0, writes.get(), "库不可用时定时裁剪也不该碰库（否则每 10 分钟一条 WARN + 堆栈）");
    }

    @Test
    void 库可用时照常写库() {
        AtomicInteger writes = new AtomicInteger();
        Analytics analytics = new Analytics(
                counting(ChatLogMapper.class, writes), counting(FeedbackMapper.class, writes), null,
                new FakeDbStatus(true), 50);

        analytics.logChat(chatLog());
        analytics.logFeedback(feedback());

        assertEquals(2, writes.get(), "库可用时两条写入都应发生");
    }

    @Test
    void 库可用时定时裁剪照常执行() {
        AtomicInteger writes = new AtomicInteger();
        Analytics analytics = new Analytics(
                null, counting(FeedbackMapper.class, writes), counting(UncoveredMapper.class, writes),
                new FakeDbStatus(true), 50);

        analytics.trimStorage(20, 50);

        assertEquals(2, writes.get(), "库可用时两条裁剪都应执行");
    }

    @Test
    void 库不可用时会话不落库但内存上下文照常() {
        AtomicInteger writes = new AtomicInteger();
        SessionStore store = new SessionStore(counting(SessionMapper.class, writes), new FakeDbStatus(false));

        store.append("s1", "问一", "答一");

        assertEquals(0, writes.get(), "库不可用不应尝试写库");
        assertEquals(2, store.history("s1").size(), "内存上下文必须照常，否则多轮追问会断");
    }

    @Test
    void 写路径异常会立即把数据库状态置为不可用() {
        DatabaseStatus status = new DatabaseStatus((HealthMapper) Proxy.newProxyInstance(
                HealthMapper.class.getClassLoader(), new Class<?>[] {HealthMapper.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("toString")) return "healthStub";
                    return null;
                }), null);

        status.markUnavailable(new IllegalStateException("connection reset"));

        assertFalse(status.available());
        assertFalse(status.shouldAttempt());
        assertTrue(status.error().contains("connection reset"));
    }

    @Test
    void 没有状态对象时按可写处理_兼容测试与旧装配() {
        AtomicInteger writes = new AtomicInteger();
        Analytics analytics = new Analytics(counting(ChatLogMapper.class, writes), null, null, null, 50);
        analytics.logChat(chatLog());
        assertEquals(1, writes.get());
    }

    @Test
    void 探活失败后_写路径在重探间隔内不再尝试() {
        HealthMapper failing = (HealthMapper) Proxy.newProxyInstance(
                HealthMapper.class.getClassLoader(), new Class<?>[] {HealthMapper.class}, (proxy, method, args) -> {
                    if (method.getName().equals("toString")) {
                        return "failingHealthMapper";
                    }
                    throw new IllegalStateException("库连不上");
                });
        DatabaseStatus status = new DatabaseStatus(failing, null);

        assertFalse(status.check(), "探活失败应报不可用");
        assertFalse(status.available());
        assertFalse(status.shouldAttempt(), "刚探活失败，60 秒内不再尝试（避免每次写都等超时）");
        assertFalse(status.shouldAttempt(), "连续调用也不该反复探活");
        assertTrue(status.error() != null && status.error().contains("库连不上"), "错误信息要留给运营排查");
    }
}
