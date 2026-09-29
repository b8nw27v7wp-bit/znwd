package com.znwd.hostess.session;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

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

    private static Object[] createSessionLocks(int count) {
        Object[] locks = new Object[count];
        for (int i = 0; i < count; i++) {
            locks[i] = new Object();
        }
        return locks;
    }

    private Object lockFor(String sessionId) {
        return sessionLocks[Math.floorMod(sessionId.hashCode(), sessionLocks.length)];
    }

    @Nullable
    private final SessionMapper mapper;
    private final DatabaseStatus databaseStatus;
    private volatile boolean lastRestoreFailed;
    private final Map<String, Entry> map = new LinkedHashMap<>();
    private final Object[] sessionLocks = createSessionLocks(64);

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
        synchronized (lockFor(sessionId)) {
            Entry entry;
            long seq;
            boolean newIncarnation = false;
            synchronized (this) {
                long now = System.currentTimeMillis();
                entry = map.get(sessionId);
                if (entry == null || !alive(entry, now)) {
                    newIncarnation = true;
                    entry = new Entry(new ArrayList<>(), now, now);
                    map.put(sessionId, entry);
                }
                entry.messages.add(ChatMessage.user(user));
                entry.messages.add(ChatMessage.assistant(assistant));
                entry.lastActive = now;
                seq = entry.nextSequence;
                entry.nextSequence += 2;
                trim(entry);
                evictOldest();
            }
            synchronized (this) {
                if (map.get(sessionId) != entry) {
                    return;
                }
            }
            if (newIncarnation) {
                clearPersisted(sessionId);
            }
            persist(sessionId, seq, user, assistant);
        }
    }

    public boolean reset(String sessionId) {
        if (sessionId == null) {
            return false;
        }
        synchronized (lockFor(sessionId)) {
            boolean removed;
            synchronized (this) {
                removed = map.remove(sessionId) != null;
            }
            if (mapper != null && (databaseStatus == null || databaseStatus.shouldAttempt())) {
                try {
                    mapper.deleteMessages(sessionId);
                    mapper.deleteSession(sessionId);
                } catch (RuntimeException e) {
                    if (databaseStatus != null) {
                        databaseStatus.markUnavailable(e);
                    }
                    log.warn("[session] 删除会话 {} 落库失败：{}", sessionId, e.getMessage());
                }
            }
            return removed;
        }
    }

    /**
     * 会话访问令牌：随 /api/chat 响应的 sessionToken 字段下发，用来证明「这个会话是自己的」。
     *
     * <p>令牌跟着会话走（存在 Entry 里）：会话被重置/淘汰/过期，令牌一并消失，不会留下
     * 「令牌还在、会话已经换了主人」的窗口。返回 null 表示**从未下发过令牌**——重启恢复的老会话
     * 以及本字段上线之前建的会话，对所有调用方继续开放（向后兼容）。
     */
    public synchronized String tokenFor(String sessionId) {
        if (sessionId == null) {
            return null;
        }
        Entry entry = map.get(sessionId);
        if (entry == null) {
            return null;
        }
        if (entry.token == null) {
            entry.token = UUID.randomUUID().toString().replace("-", "");
        }
        return entry.token;
    }

    /**
     * 归属判定：GET/DELETE /api/sessions/{id} 调它。
     *
     * <p>返回 true 的三种情况（都不泄露会话是否存在）：会话不存在（交给上层按原语义回 404 /
     * {ok:false}）、从未下发过令牌的老会话、令牌匹配。下发过令牌却不匹配 → false，上层回 404
     * 而不是 403——403 等于告诉对方「这个 sessionId 是有效的」，把枚举面又开回来了。
     * 比对用常量时间，理由与 AdminGuard 一致：逐字节试探能省掉大量猜测成本。
     */
    public synchronized boolean mayAccess(String sessionId, String token) {
        if (sessionId == null) {
            return false;
        }
        Entry entry = map.get(sessionId);
        if (entry == null || entry.token == null) {
            return true;
        }
        String supplied = token == null ? "" : token.strip();
        return MessageDigest.isEqual(entry.token.getBytes(StandardCharsets.UTF_8),
                supplied.getBytes(StandardCharsets.UTF_8));
    }

    public boolean lastRestoreFailed() {
        return lastRestoreFailed;
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
        lastRestoreFailed = false;
        long now = System.currentTimeMillis();
        int loaded = 0;
        try {
            mapper.deleteExpiredMessages(now - TTL_MS);
            mapper.deleteExpiredSessions(now - TTL_MS);
            for (SessionMapper.SessionRow row : mapper.recentSessions(now - TTL_MS, MAX_SESSIONS)) {
                if (map.containsKey(row.id())) {
                    // 内存里已有的会话更新：覆盖会把库不可用期间的追问上下文冲掉
                    continue;
                }
                List<ChatMessage> messages = new ArrayList<>();
                long nextSequence = 0;
                for (SessionMapper.MessageRow m : mapper.messages(row.id())) {
                    nextSequence = Math.max(nextSequence, m.seq() + 2L);
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
                entry.nextSequence = nextSequence;
                trim(entry);
                map.put(row.id(), entry);
                loaded++;
            }
        } catch (RuntimeException e) {
            lastRestoreFailed = true;
            if (databaseStatus != null) {
                databaseStatus.markUnavailable(e);
            }
            log.warn("[session] 从 MySQL 恢复会话失败（按空会话启动）：{}", e.getMessage());
        }
        return loaded;
    }

    private void clearPersisted(String sessionId) {
        if (mapper == null || (databaseStatus != null && !databaseStatus.shouldAttempt())) {
            return;
        }
        try {
            mapper.deleteMessages(sessionId);
            mapper.deleteSession(sessionId);
        } catch (RuntimeException e) {
            if (databaseStatus != null) {
                databaseStatus.markUnavailable(e);
            }
            log.warn("[session] 清理旧会话 {} 落库失败：{}", sessionId, e.getMessage());
        }
    }

    public void cleanupExpired() {
        if (mapper == null || (databaseStatus != null && !databaseStatus.shouldAttempt())) {
            return;
        }
        try {
            long before = System.currentTimeMillis() - TTL_MS;
            mapper.deleteExpiredMessages(before);
            mapper.deleteExpiredSessions(before);
        } catch (RuntimeException e) {
            if (databaseStatus != null) {
                databaseStatus.markUnavailable(e);
            }
            log.warn("[session] 清理过期会话失败：{}", e.getMessage());
        }
    }

    private void persist(String sessionId, long seq, String user, String assistant) {
        // 库不可用就别写：否则每次问答都要白等一次 Hikari connection-timeout（实测 3 秒）
        if (mapper == null || (databaseStatus != null && !databaseStatus.shouldAttempt())) {
            return;
        }
        try {
            long now = System.currentTimeMillis();
            mapper.upsertSession(sessionId, now, now);
            mapper.insertMessage(sessionId, Math.toIntExact(seq), "user", user);
            mapper.insertMessage(sessionId, Math.toIntExact(seq + 1), "assistant", assistant);
        } catch (RuntimeException e) {
            if (databaseStatus != null) {
                databaseStatus.markUnavailable(e);
            }
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
        private long nextSequence;
        private final long createdAt;
        /** 访问令牌；null = 从未下发过（见 tokenFor） */
        private String token;

        private Entry(List<ChatMessage> messages, long lastActive, long createdAt) {
            this.messages = messages;
            this.lastActive = lastActive;
            this.createdAt = createdAt;
        }
    }
}
