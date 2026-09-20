package com.znwd.hostess.analytics;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.znwd.hostess.domain.ChatLogEntry;
import com.znwd.hostess.domain.FeedbackEntry;
import com.znwd.hostess.llm.LlmUsage;
import com.znwd.hostess.session.SessionStore;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 会话与统计：没有 MySQL 也要能跑（仓储可空），这几条是运营报表的口径。 */
class AnalyticsSessionTest {

    @Test
    void 会话追加与查看与重置() {
        SessionStore store = new SessionStore(null);
        store.append("s1", "问一", "答一");
        assertEquals(2, store.history("s1").size());
        assertNotNull(store.peek("s1"));
        assertEquals(1, store.count());

        assertTrue(store.reset("s1"));
        assertNull(store.peek("s1"));
        assertEquals(0, store.history("s1").size());
    }

    @Test
    void 无会话ID时不记录上下文() {
        SessionStore store = new SessionStore(null);
        store.append(null, "问", "答");
        assertTrue(store.history(null).isEmpty());
        assertEquals(0, store.count());
    }

    @Test
    void 会话只保留最近六轮() {
        SessionStore store = new SessionStore(null);
        for (int i = 0; i < 10; i++) {
            store.append("s1", "问" + i, "答" + i);
        }
        List<com.znwd.hostess.llm.ChatMessage> history = store.history("s1");
        assertEquals(SessionStore.MAX_TURNS * 2, history.size());
        assertEquals("问4", history.get(0).content(), "窗口只保留最近 6 轮，最早的 问4 还在");
        assertEquals("答9", history.get(history.size() - 1).content(), "最后一轮的回答是最近一条");
    }

    @Test
    void 统计noHit与tokens并留存未覆盖问题() {
        Analytics analytics = new Analytics(null, null, null, 3);
        analytics.logChat(entry(1, "rag", false, false, null, new LlmUsage(100, 50, 0, 150)));
        analytics.logChat(entry(2, "llm_only", true, true, "会议室在哪里", null));

        Map<String, Object> stats = analytics.stats(1);
        assertEquals(2L, num(stats, "chatTotal"));
        assertEquals(1L, num(stats, "ragHits"));
        assertEquals(1L, num(stats, "noHit"));
        assertEquals(1L, num(stats, "rewritten"));
        assertEquals(1L, num(stats, "activeSessions"));

        @SuppressWarnings("unchecked")
        Map<String, Object> tokens = (Map<String, Object>) stats.get("tokens");
        assertEquals(100L, ((Number) tokens.get("prompt")).longValue());
        assertEquals(1L, ((Number) tokens.get("calls")).longValue());

        assertEquals(1, analytics.uncoveredList(10).size());
        assertEquals("会议室在哪里", analytics.uncoveredList(10).get(0).question());
    }

    @Test
    void 未覆盖清单按留存上限截断且新在前() {
        Analytics analytics = new Analytics(null, null, null, 2);
        analytics.logChat(entry(1, "llm_only", true, false, "问题A", null));
        analytics.logChat(entry(2, "llm_only", true, false, "问题B", null));
        analytics.logChat(entry(3, "llm_only", true, false, "问题C", null));
        List<com.znwd.hostess.domain.UncoveredEntry> items = analytics.uncoveredList(10);
        assertEquals(2, items.size());
        assertEquals("问题C", items.get(0).question());
    }

    @Test
    void 反馈统计按问题聚合负反馈并可导出CSV() {
        Analytics analytics = new Analytics(null, null, null, 50);
        analytics.logFeedback(new FeedbackEntry(1, "s1", "up", null, "提供培训吗？"));
        analytics.logFeedback(new FeedbackEntry(2, "s2", "down", "回答太笼统", "叶片检测要停机吗？"));
        analytics.logFeedback(new FeedbackEntry(3, "s3", "down", null, "叶片检测要停机吗？"));

        Map<String, Object> stats = analytics.feedbackStats();
        assertEquals(3L, num(stats, "total"));
        assertEquals(1L, num(stats, "up"));
        assertEquals(2L, num(stats, "down"));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> topDown = (List<Map<String, Object>>) stats.get("topDown");
        assertEquals(1, topDown.size());
        assertEquals("叶片检测要停机吗？", topDown.get(0).get("question"));
        assertEquals(2L, ((Number) topDown.get(0).get("down")).longValue());

        String csv = analytics.feedbackCsv();
        assertTrue(csv.startsWith("at,sessionId,rating,question,comment"));
        assertTrue(csv.contains("\"叶片检测要停机吗？\""));
        assertTrue(csv.contains("\"回答太笼统\""), "CSV 需转义引号");
    }

    @Test
    void 统计窗口只保留最近若干条() {
        Analytics analytics = new Analytics(null, null, null, 50);
        for (int i = 0; i < Analytics.MAX_LOGS + 20; i++) {
            analytics.logChat(entry(i, "rag", false, false, null, null));
        }
        Map<String, Object> stats = analytics.stats(0);
        assertEquals((long) Analytics.MAX_LOGS + 20, stats.get("chatTotal"), "计数是累计值，不受窗口影响");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> recent = (List<Map<String, Object>>) stats.get("recent");
        assertEquals(20, recent.size(), "recent 只展示最近 20 条");
    }

    @Test
    void 错误日志计入errors且不计入rag() {
        Analytics analytics = new Analytics(null, null, null, 50);
        analytics.logChat(new ChatLogEntry(1, "s1", "llm_only", "mock", "h#1#问", 1, "", 5, false, null, false, null,
                null, "internal_error"));
        Map<String, Object> stats = analytics.stats(0);
        assertEquals(1L, num(stats, "errors"));
        assertEquals(0L, num(stats, "ragHits"));
        assertEquals(0L, num(stats, "llmOnly"), "错误既不是 rag 也不是 llm_only");
        assertEquals(1L, num(stats, "chatTotal"));
    }

    @Test
    void 无usage时token统计为零而不报错() {
        Analytics analytics = new Analytics(null, null, null, 50);
        analytics.logChat(entry(1, "rag", false, false, null, null));
        @SuppressWarnings("unchecked")
        Map<String, Object> tokens = (Map<String, Object>) analytics.stats(0).get("tokens");
        assertEquals(0L, ((Number) tokens.get("prompt")).longValue());
        assertEquals(0L, ((Number) tokens.get("calls")).longValue());
    }

    /** 统计值有 int/long 两种来源，统一按数值比较，避免装箱类型差异造成假失败 */
    private static long num(Map<String, Object> stats, String key) {
        return ((Number) stats.get(key)).longValue();
    }

    private static ChatLogEntry entry(long at, String mode, boolean noHit, boolean rewritten, String question,
                                      LlmUsage usage) {
        return new ChatLogEntry(at, "s1", mode, "mock", "hash#4#问", 4, "答", 12, noHit, "keyword", rewritten,
                question, usage, null);
    }
}
