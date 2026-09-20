package com.znwd.hostess.session;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.lang.Nullable;

import com.znwd.hostess.llm.ChatMessage;
import com.znwd.hostess.llm.ChatRole;
import com.znwd.hostess.repository.DatabaseStatus;
import com.znwd.hostess.repository.SessionMapper;

/**
 * 会话记忆：近 6 轮上下文 + 10 分钟 TTL + 200 会话上限，同时落库 MySQL。
 *
 * <p>为什么落库：展厅每天开关机，原来的纯内存会话一重启就没了，运营侧也拿不到历史。
 * 内存仍然是读取路径（快），MySQL 是恢复与留痕的来源。
 */
public class SessionStore {

    private static final Logger log = LoggerFactory.getLogger(SessionStore.class);

    public static final int MAX_TURNS = 6;
    public static final long TTL_MS = 10 * 60 * 1000L;
    public static final int MAX_SESSIONS = 200;

    @Nullable
    private final SessionMapper mapper;
    private final DatabaseStatus databaseStatus;
    private final Map<String, Entry> map = new LinkedHashMap<>();

    public SessionStore(@Nullable SessionMapper mapper, @Nullable DatabaseStatus databaseStatus) {
        this.mapper = mapper;
        this.databaseStatus = databaseStatus;
    }

    /** 供 LLM 使用：刷新 lastActive */
    public synchronized List<ChatMessage> history(String sessionId) {
        if (sessionId == null) {
            return List.of();
        }
        long now = System.currentTimeMillis();
        Entry entry = map.get(sessionId);
        if (entry == null || !alive(entry, now)) {
            map.remove(sessionId);
            return List.of();
        }
        entry.lastActive = now;
        trim(entry);
        return new ArrayList<>(entry.messages);
    }

    /** 只读查看，不刷新 TTL */
    public synchronized Peek peek(String sessionId) {
        long now = System.currentTimeMillis();
        Entry entry = map.get(sessionId);
        if (entry == null || !alive(entry, now)) {
            map.remove(sessionId);
            return null;
        }
        trim(entry);
        return new Peek(new ArrayList<>(entry.messages), entry.lastActive);
    }

    public void append(String sessionId, String user, String assistant) {
        if (sessionId == null) {
            return;
        }
        int seq;
        synchronized (this) {
            long now = System.currentTimeMillis();
            Entry entry = map.get(sessionId);
            if (entry == null || !alive(entry, now)) {
                entry = new Entry(new ArrayList<>(), now, now);
                map.put(sessionId, entry);
            }
            entry.messages.add(ChatMessage.user(user));
            entry.messages.add(ChatMessage.assistant(assistant));
            entry.lastActive = now;
            trim(entry);
            evictOldest();
            seq = entry.messages.size() - 2;
        }
        persist(sessionId, seq, user, assistant);
    }

    public synchronized boolean reset(String sessionId) {
        if (sessionId == null) {
            return false;
        }
        boolean removed = map.remove(sessionId) != null;
        if (mapper != null) {
            try {
                mapper.deleteMessages(sessionId);
                mapper.deleteSession(sessionId);
            } catch (RuntimeException e) {
                log.warn("[session] 删除会话 {} 落库失败：{}", sessionId, e.getMessage());
            }
        }
        return removed;
    }

    public synchronized int count() {
        long now = System.currentTimeMillis();
        int n = 0;
        for (Entry entry : map.values()) {
            if (alive(entry, now)) {
                n++;
            }
        }
        return n;
    }

    /**
     * 启动时从 MySQL 恢复未过期会话，并清掉库里的过期数据（否则表会一直涨）。
     *
     * @return 恢复的会话数
     */
    public synchronized int restore() {
        if (mapper == null) {
            return 0;
        }
        long now = System.currentTimeMillis();
        int loaded = 0;
        try {
            mapper.deleteExpiredMessages(now - TTL_MS);
            mapper.deleteExpiredSessions(now - TTL_MS);
            for (SessionMapper.SessionRow row : mapper.recentSessions(now - TTL_MS, MAX_SESSIONS)) {
                List<ChatMessage> messages = new ArrayList<>();
                for (SessionMapper.MessageRow m : mapper.messages(row.id())) {
                    ChatRole role = switch (m.role() == null ? "" : m.role()) {
                        case "user" -> ChatRole.USER;
                        case "assistant" -> ChatRole.ASSISTANT;
                        default -> ChatRole.SYSTEM;
                    };
                    if (m.content() != null) {
                        messages.add(new ChatMessage(role, m.content()));
                    }
                }
                Entry entry = new Entry(messages, row.lastActive(), row.createdAt());
                trim(entry);
                map.put(row.id(), entry);
                loaded++;
            }
        } catch (RuntimeException e) {
            log.warn("[session] 从 MySQL 恢复会话失败（按空会话启动）：{}", e.getMessage());
        }
        return loaded;
    }

    private void persist(String sessionId, int seq, String user, String assistant) {
        // 库不可用就别写：否则每次问答都要白等一次 Hikari connection-timeout（实测 3 秒）
        if (mapper == null || (databaseStatus != null && !databaseStatus.shouldAttempt())) {
            return;
        }
        try {
            long now = System.currentTimeMillis();
            mapper.upsertSession(sessionId, now, now);
            mapper.insertMessage(sessionId, seq, "user", user);
            mapper.insertMessage(sessionId, seq + 1, "assistant", assistant);
        } catch (RuntimeException e) {
            // 落库失败不阻断问答：展厅现场宁可丢一条历史，也不能让讲解中断
            log.warn("[session] 会话 {} 落库失败：{}", sessionId, e.getMessage());
        }
    }

    private static boolean alive(Entry entry, long now) {
        return now - entry.lastActive <= TTL_MS;
    }

    private static void trim(Entry entry) {
        int limit = MAX_TURNS * 2;
        if (entry.messages.size() > limit) {
            entry.messages = new ArrayList<>(entry.messages.subList(entry.messages.size() - limit, entry.messages.size()));
        }
    }

    private void evictOldest() {
        if (map.size() <= MAX_SESSIONS) {
            return;
        }
        List<Map.Entry<String, Entry>> sorted = new ArrayList<>(map.entrySet());
        sorted.sort(Comparator.comparingLong(e -> e.getValue().lastActive));
        int excess = map.size() - MAX_SESSIONS;
        for (int i = 0; i < excess && i < sorted.size(); i++) {
            map.remove(sorted.get(i).getKey());
        }
    }

    public record Peek(List<ChatMessage> messages, long lastActive) {
    }

    private static final class Entry {
        private List<ChatMessage> messages;
        private long lastActive;
        private final long createdAt;

        private Entry(List<ChatMessage> messages, long lastActive, long createdAt) {
            this.messages = messages;
            this.lastActive = lastActive;
            this.createdAt = createdAt;
        }
    }
}
