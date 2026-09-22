package com.znwd.hostess.http;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 限流键的取值。
 *
 * <p>`X-Forwarded-For` 是**客户端可写**的头：无条件采信它，等于让调用方自己挑限流桶——
 * 每个请求换一个值就是一个新桶，`CHAT_RATE_PER_MIN` 直接失效。默认必须忽略它，
 * 只有运维显式打开开关（且确认反代会剥离同名头）时才用。
 */
class ClientIpTest {

    @Test
    void 默认忽略转发头_用真实远端地址() {
        assertEquals("192.168.1.9", ClientIp.of("1.2.3.4", "192.168.1.9", false));
        // 伪造头不会改变结果——这就是默认值的意义
        assertEquals("192.168.1.9", ClientIp.of("9.9.9.9, 8.8.8.8", "192.168.1.9", false));
    }

    @Test
    void 显式信任时取转发头的首个地址() {
        assertEquals("1.2.3.4", ClientIp.of("1.2.3.4, 10.0.0.1", "127.0.0.1", true));
        assertEquals("1.2.3.4", ClientIp.of("  1.2.3.4  ", "127.0.0.1", true));
    }

    @Test
    void 信任但转发头缺失或为空时回落远端地址() {
        assertEquals("127.0.0.1", ClientIp.of(null, "127.0.0.1", true));
        assertEquals("127.0.0.1", ClientIp.of("   ", "127.0.0.1", true));
        assertEquals("127.0.0.1", ClientIp.of(",", "127.0.0.1", true));
    }

    @Test
    void 拿不到地址时用固定标识_不落成空串() {
        assertEquals("unknown", ClientIp.of(null, null, false));
        assertEquals("unknown", ClientIp.of(null, "  ", false));
    }
}
