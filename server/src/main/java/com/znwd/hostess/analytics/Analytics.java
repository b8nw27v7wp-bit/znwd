package com.znwd.hostess.analytics;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.lang.Nullable;

import com.znwd.hostess.domain.ChatLogEntry;
import com.znwd.hostess.domain.FeedbackEntry;
import com.znwd.hostess.domain.UncoveredEntry;
import com.znwd.hostess.llm.LlmUsage;
import com.znwd.hostess.repository.ChatLogMapper;
import com.znwd.hostess.repository.FeedbackMapper;
import com.znwd.hostess.repository.UncoveredMapper;

/**
 * 运营统计：问答计数、未覆盖问题清单、反馈汇总、token 成本。
 *
 * <p>内存里保留最近若干条用于快速出报表（原实现只有内存），同时全部落 MySQL：展厅关机重启后
 * 计数与反馈历史仍然在，这是原来最大的缺口。
 */
public class Analytics {

    private static final Logger log = LoggerFactory.getLogger(Analytics.class);

    public static final int MAX_LOGS = 500;
    public static final int MAX_FEEDBACK = 500;

    @Nullable
    private final ChatLogMapper chatLogMapper;
    @Nullable
    private final FeedbackMapper feedbackMapper;
    @Nullable
    private final UncoveredMapper uncoveredMapper;
    private final int maxUncovered;

    private final List<ChatLogEntry> logs = new ArrayList<>();
    private final List<FeedbackEntry> feedback = new ArrayList<>();
    private final List<UncoveredEntry> uncovered = new ArrayList<>();

    private long startedAt = System.currentTimeMillis();
    private long chatTotal;
    private long ragHits;
    private long errors;
    private long noHits;
    private long rewritten;
    private final TokenTotals tokens = new TokenTotals();

    public Analytics(@Nullable ChatLogMapper chatLogMapper, @Nullable FeedbackMapper feedbackMapper,
                     @Nullable UncoveredMapper uncoveredMapper, int uncoveredLogSize) {
        this.chatLogMapper = chatLogMapper;
        this.feedbackMapper = feedbackMapper;
        this.uncoveredMapper = uncoveredMapper;
        this.maxUncovered = Math.max(0, uncoveredLogSize);
    }

    public void logChat(ChatLogEntry item) {
        // 内存部分加锁、数据库写在锁外：库慢不能拖住其它请求（问答热路径只碰内存）
        synchronized (this) {
            chatTotal++;
            if ("rag".equals(item.mode())) {
                ragHits++;
            }
            if (item.noHit()) {
                noHits++;
            }
            if (item.rewritten()) {
                rewritten++;
            }
            if (item.error() != null && !item.error().isBlank()) {
                errors++;
            }
            LlmUsage usage = item.usage();
            if (usage != null && usage.hasAny()) {
                tokens.calls++;
                tokens.prompt += nullToZero(usage.promptTokens());
                tokens.completion += nullToZero(usage.completionTokens());
                tokens.reasoning += nullToZero(usage.reasoningTokens());
                tokens.total += usage.totalTokens() != null
                        ? usage.totalTokens()
                        : nullToZero(usage.promptTokens()) + nullToZero(usage.completionTokens());
            }
            if (item.noHit() && item.questionForUncovered() != null && maxUncovered > 0) {
                uncovered.add(0, new UncoveredEntry(item.at(), item.sessionId(), item.questionForUncovered()));
                while (uncovered.size() > maxUncovered) {
                    uncovered.remove(uncovered.size() - 1);
                }
            }
            logs.add(0, item);
            while (logs.size() > MAX_LOGS) {
                logs.remove(logs.size() - 1);
            }
        }

        if (chatLogMapper != null) {
            try {
                chatLogMapper.insert(item);
            } catch (RuntimeException e) {
                log.warn("[analytics] 问答日志落库失败：{}", e.getMessage());
            }
        }
        // 未覆盖问题单独成表：它是运营补资料的待办清单，重启后必须还在
        if (uncoveredMapper != null && maxUncovered > 0
                && item.noHit() && item.questionForUncovered() != null) {
            try {
                uncoveredMapper.insert(new UncoveredEntry(item.at(), item.sessionId(), item.questionForUncovered()));
            } catch (RuntimeException e) {
                log.warn("[analytics] 未覆盖问题落库失败：{}", e.getMessage());
            }
        }
    }

    public void logFeedback(FeedbackEntry item) {
        synchronized (this) {
            feedback.add(0, item);
            while (feedback.size() > MAX_FEEDBACK) {
                feedback.remove(feedback.size() - 1);
            }
        }
        if (feedbackMapper != null) {
            try {
                feedbackMapper.insert(item);
            } catch (RuntimeException e) {
                log.warn("[analytics] 反馈落库失败：{}", e.getMessage());
            }
        }
    }

    /** 未覆盖问题清单（新→旧），供运营补资料 */
    public synchronized List<UncoveredEntry> uncoveredList(int limit) {
        int size = Math.min(Math.max(limit, 0), uncovered.size());
        return new ArrayList<>(uncovered.subList(0, size));
    }

    public synchronized Map<String, Object> stats(int activeSessions) {
        long up = feedback.stream().filter(FeedbackEntry::up).count();
        long down = feedback.stream().filter(FeedbackEntry::down).count();
        List<Map<String, Object>> recent = new ArrayList<>();
        for (ChatLogEntry l : logs.subList(0, Math.min(20, logs.size()))) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("at", l.at());
            row.put("sessionId", l.sessionId());
            row.put("mode", l.mode());
            row.put("noHit", l.noHit());
            row.put("messagePreview", l.messagePreview());
            row.put("latencyMs", l.latencyMs());
            row.put("error", l.error());
            recent.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("uptimeSec", (System.currentTimeMillis() - startedAt) / 1000);
        out.put("chatTotal", chatTotal);
        out.put("ragHits", ragHits);
        out.put("llmOnly", chatTotal - ragHits - errors);
        out.put("noHit", noHits);
        out.put("rewritten", rewritten);
        out.put("uncoveredCount", uncovered.size());
        out.put("tokens", tokens.asMap());
        out.put("errors", errors);
        out.put("activeSessions", activeSessions);
        out.put("feedback", Map.of("up", up, "down", down));
        out.put("recent", recent);
        return out;
    }

    /** 负反馈汇总，便于知识回流 */
    public synchronized Map<String, Object> feedbackStats() {
        List<FeedbackEntry> all = new ArrayList<>(feedback);
        long total = all.size();
        long up = all.stream().filter(FeedbackEntry::up).count();
        List<FeedbackEntry> downItems = all.stream().filter(FeedbackEntry::down).toList();

        Map<String, Map<String, Object>> byQuestion = new LinkedHashMap<>();
        for (FeedbackEntry f : downItems) {
            String q = cut(firstNonBlank(f.question(), f.comment(), "(未记录问题)"), 200);
            Map<String, Object> prev = byQuestion.computeIfAbsent(q, k -> {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("question", k);
                m.put("down", 0L);
                m.put("comments", new ArrayList<String>());
                return m;
            });
            prev.put("down", (Long) prev.get("down") + 1);
            if (f.comment() != null) {
                @SuppressWarnings("unchecked")
                List<String> comments = (List<String>) prev.get("comments");
                comments.add(cut(f.comment(), 200));
            }
        }
        List<Map<String, Object>> topDown = byQuestion.values().stream()
                .sorted(Comparator.comparingLong((Map<String, Object> m) -> (Long) m.get("down")).reversed())
                .limit(20)
                .toList();

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("total", total);
        out.put("up", up);
        out.put("down", downItems.size());
        out.put("downRate", total > 0 ? round(downItems.size() / (double) total, 4) : 0);
        out.put("topDown", topDown);
        out.put("recent", feedback.stream().limit(20).map(Analytics::feedbackRow).toList());
        out.put("recentDown", downItems.stream().limit(20).map(Analytics::feedbackRow).toList());
        return out;
    }

    public synchronized String feedbackCsv() {
        StringBuilder sb = new StringBuilder("at,sessionId,rating,question,comment");
        for (FeedbackEntry f : feedback) {
            sb.append('\n')
                    .append(f.at()).append(',')
                    .append(esc(f.sessionId())).append(',')
                    .append(f.rating()).append(',')
                    .append(esc(f.question())).append(',')
                    .append(esc(f.comment()));
        }
        return sb.toString();
    }

    /**
     * 启动时从 MySQL 恢复计数与反馈（重启不清零）。
     *
     * @return 恢复的反馈条数
     */
    public synchronized int restore() {
        if (chatLogMapper != null) {
            try {
                ChatLogMapper.Counters c = chatLogMapper.counters();
                if (c != null) {
                    chatTotal = c.chatTotal();
                    ragHits = c.ragHits();
                    errors = c.errors();
                    noHits = c.noHits();
                    rewritten = c.rewritten();
                    tokens.prompt = c.promptTokens();
                    tokens.completion = c.completionTokens();
                    tokens.reasoning = c.reasoningTokens();
                    tokens.total = c.totalTokens();
                    tokens.calls = c.tokenCalls();
                }
                for (ChatLogMapper.RecentChatRow row : chatLogMapper.recent(MAX_LOGS)) {
                    logs.add(new ChatLogEntry(row.at(), row.sessionId(), row.mode(), "", row.messagePreview(),
                            null, "", row.latencyMs(), row.noHit(), null, false, null, null, row.error()));
                }
            } catch (RuntimeException e) {
                log.warn("[analytics] 从 MySQL 恢复统计失败（按零启动）：{}", e.getMessage());
            }
        }
        if (feedbackMapper != null) {
            try {
                feedback.addAll(feedbackMapper.recent(MAX_FEEDBACK));
            } catch (RuntimeException e) {
                log.warn("[analytics] 恢复反馈失败：{}", e.getMessage());
            }
        }
        if (uncoveredMapper != null && maxUncovered > 0) {
            try {
                uncovered.addAll(uncoveredMapper.latest(maxUncovered));
            } catch (RuntimeException e) {
                log.warn("[analytics] 恢复未覆盖清单失败：{}", e.getMessage());
            }
        }
        return feedback.size();
    }

    /** 定时裁剪：反馈/未覆盖清单只保留最近部分，展厅跑半年也不会把表撑爆 */
    public void trimStorage(int keepFeedback, int keepUncovered) {
        try {
            if (feedbackMapper != null) {
                feedbackMapper.trim(keepFeedback);
            }
            if (uncoveredMapper != null) {
                uncoveredMapper.trim(keepUncovered);
            }
        } catch (RuntimeException e) {
            log.warn("[analytics] 裁剪历史数据失败：{}", e.getMessage());
        }
    }

    private static Map<String, Object> feedbackRow(FeedbackEntry f) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("at", f.at());
        row.put("sessionId", f.sessionId());
        row.put("rating", f.rating());
        row.put("question", f.question());
        row.put("comment", f.comment());
        return row;
    }

    private static String esc(String s) {
        String v = s == null ? "" : s;
        return "\"" + v.replace("\"", "\"\"") + "\"";
    }

    private static String cut(String s, int max) {
        if (s == null) {
            return null;
        }
        return s.length() <= max ? s : s.substring(0, max);
    }

    private static String firstNonBlank(String... values) {
        for (String v : values) {
            if (v != null && !v.isBlank()) {
                return v;
            }
        }
        return "";
    }

    private static long nullToZero(Integer v) {
        return v == null ? 0 : v;
    }

    private static double round(double value, int digits) {
        double factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }

    public static final class TokenTotals {
        private long prompt;
        private long completion;
        private long reasoning;
        private long total;
        private long calls;

        public Map<String, Object> asMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("prompt", prompt);
            m.put("completion", completion);
            m.put("reasoning", reasoning);
            m.put("total", total);
            m.put("calls", calls);
            return m;
        }
    }
}
