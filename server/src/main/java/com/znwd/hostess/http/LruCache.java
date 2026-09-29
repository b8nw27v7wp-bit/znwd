package com.znwd.hostess.http;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** LRU 答案缓存。key 里带模型名与索引 generation：reload 之后旧代答案不会被误命中。 */
public class LruCache<V> {

    private final int max;
    private final Map<String, V> map = new LinkedHashMap<>(16, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, V> eldest) {
            return size() > max;
        }
    };

    public LruCache(int max) {
        this.max = Math.max(1, max);
    }

    public synchronized V get(String key) {
        return map.get(key);
    }

    public synchronized void put(String key, V value) {
        map.put(key, value);
    }

    public synchronized int size() {
        return map.size();
    }

    public synchronized void clear() {
        map.clear();
    }

    /** 缓存 key：模型 + 索引代数 + 完整规范化问题的 SHA-256 */
    public static String answerCacheKey(String message, String model, long generation) {
        String normalized = message == null ? "" : message.strip().toLowerCase(Locale.ROOT);
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(normalized.getBytes(StandardCharsets.UTF_8));
            return model + "::g" + generation + "::" + HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    /** 缓存条目（只放「单轮且无历史」的回答：多轮上下文不同，复用得靠 session 历史判断） */
    public record CachedAnswer(
            String answer,
            Object sources,
            String mode,
            String provider,
            String retrieval,
            boolean noHit) {
    }
}
