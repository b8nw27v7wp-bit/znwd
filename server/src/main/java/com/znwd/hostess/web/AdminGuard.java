package com.znwd.hostess.web;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

import com.znwd.hostess.config.AppProperties;

/**
 * 管理接口鉴权。
 *
 * <p>规则与老实现一致：配置了 ADMIN_TOKEN 就必须带对；生产（NODE_ENV=production 或
 * REQUIRE_ADMIN_TOKEN=true）未配置 token 时直接 401，而不是「悄悄开放」。
 *
 * <p>另加一条 fail-closed：**请求不是从本机回环地址进来的**（说明服务绑到了 0.0.0.0 或被反代暴露），
 * 即使没设 NODE_ENV 也必须带口令。展厅部署最容易踩的组合是「HOST=0.0.0.0 + 忘配 ADMIN_TOKEN」——
 * 那等于把统计、知识重载、诊断、同义词表全对局域网开放；这里把它变成拒绝而不是提醒。
 *
 * <p>比对用常量时间：字符串 equals 会在第一个不同字节处返回，理论上能被逐字节试探口令。
 */
public final class AdminGuard {

    private AdminGuard() {
    }

    public static void require(String authorizationHeader, AppProperties props, String localAddr) {
        String token = props.adminTokenOrNull();
        if (token == null) {
            if (tokenRequiredNow(props, localAddr)) {
                throw ApiException.unauthorized();
            }
            return;
        }
        String raw = authorizationHeader == null ? "" : authorizationHeader.replaceAll("(?i)^Bearer\\s+", "");
        if (!constantTimeEquals(token, raw.strip())) {
            throw ApiException.unauthorized();
        }
    }

    /**
     * 本次请求下管理口令是否必需（未配置口令时的判据）。健康接口上报同一个值，
     * 免得「接口 401 而 /api/health 说不需要口令」这种自相矛盾。
     */
    public static boolean tokenRequiredNow(AppProperties props, String localAddr) {
        return props.adminTokenRequired() || !isLoopback(localAddr);
    }

    /** 回环地址判定：拿不到地址时按非本机处理（宁可多要一次口令） */
    private static boolean isLoopback(String localAddr) {
        if (localAddr == null || localAddr.isBlank()) {
            return false;
        }
        String addr = localAddr.strip();
        return addr.startsWith("127.")
                || "::1".equals(addr)
                || "0:0:0:0:0:0:0:1".equals(addr)
                || "localhost".equalsIgnoreCase(addr);
    }

    private static boolean constantTimeEquals(String expected, String actual) {
        byte[] a = expected.getBytes(StandardCharsets.UTF_8);
        byte[] b = actual.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(a, b);
    }
}
