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
     * 会话访问令牌的**唯一一次交付窗口**：会话首次创建的那次问答响应。
     *
     * <p>令牌本身在会话创建（append 新纪元）时就铸好存在 Entry 里，这里只负责「交出去」，
     * 交付过一次就再也不给——这是 P0-2 的核心：前端把 sessionId 放 localStorage（展厅同一台机
     * 连续使用），若仅凭 sessionId 就能反复换取令牌，下一位访客的 chat 响应会直接拿到上一位的
     * 令牌，再 GET /api/sessions/{id} 把整段对话读走。
     *
     * <p>返回 null 的三种情况：没建过会话（sessionId 为空/不存在）、**已经交付过**、
     * 重启恢复的老会话（restore 里铸好并直接标记为已交付，历史对 API 关闭，等 TTL 清理）。
     * 返回 null 不影响旧令牌继续可用——持有者拿旧令牌走 {@link #mayAccess} 照常读得到。
     */
    public synchronized String issueTokenOnce(String sessionId) {
        if (sessionId == null) {
            return null;
        }
        Entry entry = map.get(sessionId);
        if (entry == null || entry.tokenIssued) {
            return null;
        }
        entry.tokenIssued = true;
        return entry.token;
    }

    /**
     * 归属判定：GET/DELETE /api/sessions/{id} 调它。
     *
     * <p>返回 true 的两种情况（都不泄露会话是否存在）：会话不存在（交给上层按原语义回 404 /
     * {ok:false}）、令牌匹配。会话存在但令牌缺失/不匹配 → false，上层回 404 而不是 403——
     * 403 等于告诉对方「这个 sessionId 是有效的」，把枚举面又开回来了。
     *
     * <p>每个会话的 Entry 都有令牌（创建或恢复时铸造），所以「没有令牌就放行」的兼容口子
     * 已经收掉：否则重启恢复的老会话（令牌从不下发）会变成**无凭证可读历史**的后门。
     * 比对用常量时间，理由与 AdminGuard 一致：逐字节试探能省掉大量猜测成本。
     */
    public synchronized boolean mayAccess(String sessionId, String token) {
        if (sessionId == null) {
            return false;
        }
        Entry entry = map.get(sessionId);
        if (entry == null) {
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
     * <p>**查库全在锁外**：deleteExpired×2 + recentSessions + 每会话的 messages 查询很慢，
     * 早先整段放在 {@code synchronized} 里，启动/恢复期会把 history/peek/issueTokenOnce/mayAccess/append
     * 全部堵死（库一慢，展厅的问答就跟着卡）。现在先在锁外把数据取好，再进短锁整体合并。
     *
     * <p>合并时已存在的会话跳过：内存里那条可能带着库不可用期间的追问上下文，覆盖会把它冲掉。
     *
     * <p>恢复来的会话在内存里铸好令牌但**标记为已交付**——没人持有它，历史对 API 关闭，
     * 等 TTL 自然清理。这是 P0-2 的另一半：老会话不能被 attach 重新换一枚令牌把历史送出去。
     *
     * @return 恢复的会话数
     */
    public int restore() {
        if (mapper == null) {
            return 0;
        }
        lastRestoreFailed = false;
        long now = System.currentTimeMillis();
        Map<String, Entry> restored = new LinkedHashMap<>();
        try {
            mapper.deleteExpiredMessages(now - TTL_MS);
            mapper.deleteExpiredSessions(now - TTL_MS);
            for (SessionMapper.SessionRow row : mapper.recentSessions(now - TTL_MS, MAX_SESSIONS)) {
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
                // 恢复的会话令牌从不下发（等价于「已经交付过」）：只拿 sessionId 的人读不走历史
                entry.tokenIssued = true;
                trim(entry);
                restored.putIfAbsent(row.id(), entry);
            }
        } catch (RuntimeException e) {
            lastRestoreFailed = true;
            if (databaseStatus != null) {
                databaseStatus.markUnavailable(e);
            }
            log.warn("[session] 从 MySQL 恢复会话失败（按空会话启动）：{}", e.getMessage());
        }
        int loaded = 0;
        synchronized (this) {
            for (Map.Entry<String, Entry> pending : restored.entrySet()) {
                if (map.containsKey(pending.getKey())) {
                    // 内存里已有的会话更新：覆盖会把库不可用期间的追问上下文冲掉
                    continue;
                }
                map.put(pending.getKey(), pending.getValue());
                loaded++;
            }
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
        /** 访问令牌：会话创建时即铸造（非 null），交付与否见 {@code tokenIssued} */
        private final String token;
        /** 是否已经随问答响应交付给客户端——一个会话至多一次（见 issueTokenOnce） */
        private boolean tokenIssued;

        private Entry(List<ChatMessage> messages, long lastActive, long createdAt) {
            this.messages = messages;
            this.lastActive = lastActive;
            this.createdAt = createdAt;
            this.token = UUID.randomUUID().toString().replace("-", "");
        }
    }
}
