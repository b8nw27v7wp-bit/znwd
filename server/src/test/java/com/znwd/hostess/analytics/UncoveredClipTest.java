package com.znwd.hostess.analytics;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;

import org.junit.jupiter.api.Test;

import com.znwd.hostess.domain.ChatLogEntry;
import com.znwd.hostess.domain.UncoveredEntry;
import com.znwd.hostess.repository.UncoveredMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 未覆盖问题的落库长度。
 *
 * <p>这条来自一次真库上的 WARN（不是推断）：
 *
 * <pre>
 * [analytics] 未覆盖问题落库失败：Data too long for column 'question' at row 1
 * </pre>
 *
 * <p>访客提问在入参阶段被截到 2000 字，而 `uncovered_question.question` 是 varchar(512)——
 * 超长插入抛 DataTruncation，被 `catch (RuntimeException)` 变成一条 WARN，接口照常回 200，
 * 运营的补资料清单却悄悄少一条。**落库路径的失败要连真库数行数才看得见**；这里守的是
 * 「进 mapper 之前就已经按列宽截断」。
 */
class UncoveredClipTest {

    /** 与 schema.sql 里 `uncovered_question.question` 的 varchar(512) 对齐 */
    private static final int COLUMN_MAX = 512;

    /** 记录 insert 参数的 mapper 替身（MyBatis 接口用动态代理） */
    private static List<UncoveredEntry> captureInto(UncoveredMapper[] holder) {
        List<UncoveredEntry> inserted = new ArrayList<>();
        holder[0] = (UncoveredMapper) Proxy.newProxyInstance(
                UncoveredMapper.class.getClassLoader(), new Class<?>[] {UncoveredMapper.class},
                (proxy, method, args) -> {
                    if ("toString".equals(method.getName())) {
                        return "CapturingUncoveredMapper";
                    }
                    if ("insert".equals(method.getName())) {
                        inserted.add((UncoveredEntry) args[0]);
                    }
                    Class<?> returnType = method.getReturnType();
                    if (returnType == int.class) {
                        return 0;
                    }
                    if (returnType == List.class) {
                        return List.of();
                    }
                    return null;
                });
        return inserted;
    }

    private static ChatLogEntry chat(boolean noHit, String question) {
        return new ChatLogEntry(1_700_000_000_000L, "s-1", noHit ? "llm_only" : "rag", "mock",
                "hash#10#前缀", 10, "答", 12L, noHit, "keyword", false, question, null, null);
    }

    @Test
    void 超长提问在进mapper之前就被截到列宽_不会静默丢行() {
        UncoveredMapper[] holder = new UncoveredMapper[1];
        List<UncoveredEntry> inserted = captureInto(holder);
        Analytics analytics = new Analytics(null, null, holder[0], null, 50);
        String longQuestion = "问".repeat(2000); // 入参阶段的上限

        analytics.logChat(chat(true, longQuestion));

        assertEquals(1, inserted.size(), "超长问题必须仍然落库（否则运营的清单会少一条）");
        assertEquals(COLUMN_MAX, inserted.get(0).question().length());
        assertEquals(longQuestion.substring(0, COLUMN_MAX), inserted.get(0).question());

        // 内存清单用同一个截断值：重启后同一条问题不该「变长」
        assertEquals(COLUMN_MAX, analytics.uncoveredList(1).get(0).question().length());
    }

    @Test
    void 正常长度原样落库() {
        UncoveredMapper[] holder = new UncoveredMapper[1];
        List<UncoveredEntry> inserted = captureInto(holder);
        Analytics analytics = new Analytics(null, null, holder[0], null, 50);

        analytics.logChat(chat(true, "你们有多少客户"));

        assertEquals(List.of("你们有多少客户"), inserted.stream().map(UncoveredEntry::question).toList());
        assertEquals("你们有多少客户", analytics.uncoveredList(1).get(0).question());
    }

    @Test
    void 命中知识库的提问不进未覆盖清单() {
        UncoveredMapper[] holder = new UncoveredMapper[1];
        List<UncoveredEntry> inserted = captureInto(holder);
        Analytics analytics = new Analytics(null, null, holder[0], null, 50);

        analytics.logChat(chat(false, "清洁机器人有多重"));

        assertTrue(inserted.isEmpty());
        assertTrue(analytics.uncoveredList(10).isEmpty());
    }
}
