package com.znwd.hostess.http;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 极简滑动窗口限流（按 IP），用于展厅单机防刷。
 *
 * <p>两个细节是踩出来的：命中限制时刷新插入序（否则活跃 IP 可能被淘汰策略误删），
 * 以及键数量上限（否则被随机 IP 刷爆内存）。
 */
public class RateLimiter {

    private static final int MAX_KEYS = 1000;

    private final int limit;
    private final long windowMs;
    private final Map<String, long[]> hits = new LinkedHashMap<>(16, 0.75f, true);

    public RateLimiter(int limit, long windowMs) {
        this.limit = Math.max(1, limit);
        this.windowMs = windowMs;
    }

    /** @return null 表示放行；否则为建议等待秒数 */
    public synchronized Long allow(String key) {
        long now = System.currentTimeMillis();
        long[] arr = hits.get(key);
        long[] fresh;
        if (arr == null) {
            fresh = new long[0];
        } else {
            fresh = java.util.Arrays.stream(arr).filter(t -> now - t < windowMs).toArray();
        }
        if (fresh.length >= limit) {
            long oldest = fresh.length > 0 ? fresh[0] : now;
            hits.put(key, fresh);
            return Math.max(1, (long) Math.ceil((oldest + windowMs - now) / 1000.0));
        }
        long[] next = java.util.Arrays.copyOf(fresh, fresh.length + 1);
        next[fresh.length] = now;
        hits.put(key, next);
        prune();
        return null;
    }

    private void prune() {
        while (hits.size() > MAX_KEYS) {
            String oldest = hits.keySet().iterator().next();
            hits.remove(oldest);
        }
    }

    /** 清理过期窗口（定时任务调用，避免长时间运行后数组越攒越大） */
    public synchronized void evictExpired() {
        long now = System.currentTimeMillis();
        hits.entrySet().removeIf(e -> {
            long[] keep = java.util.Arrays.stream(e.getValue()).filter(t -> now - t < windowMs).toArray();
            if (keep.length == 0) {
                return true;
            }
            e.setValue(keep);
            return false;
        });
    }

    public synchronized int trackedKeys() {
        return new HashMap<>(hits).size();
    }
}
