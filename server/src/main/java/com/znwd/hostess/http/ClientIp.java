package com.znwd.hostess.http;

/**
 * 限流用的客户端标识。
 *
 * <p>**默认不信任 `X-Forwarded-For`**：那个头是客户端自己可以随便写的，直接采信等于把限流键交给调用方——
 * 每次请求换一个值就是一个新桶，`CHAT_RATE_PER_MIN` 形同虚设。展厅若把 `HOST` 改成 `0.0.0.0`
 * 暴露到局域网，这一点就是可被随手绕过的口子。
 *
 * <p>只有运维显式打开 `TRUST_FORWARDED_FOR=true`（确认前面确实挂了自己掌控的反代、且反代会**剥离**
 * 客户端自带的同名头）时才取它的首个地址。反代在同机时留默认值反而更安全：所有访客共用一个桶，
 * 限流更严而不会误放。
 */
public final class ClientIp {

    private ClientIp() {
    }

    public static String of(String forwardedFor, String remoteAddr, boolean trustForwarded) {
        if (trustForwarded && forwardedFor != null && !forwardedFor.isBlank()) {
            // limit=2：`",".split(",")` 返回的是空数组，直接取 [0] 会越界（单测里踩到过）
            String first = forwardedFor.split(",", 2)[0].strip();
            if (!first.isEmpty()) {
                return first;
            }
        }
        return remoteAddr == null || remoteAddr.isBlank() ? "unknown" : remoteAddr;
    }
}
