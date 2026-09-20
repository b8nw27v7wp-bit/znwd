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
 * <p>比对用常量时间：字符串 equals 会在第一个不同字节处返回，理论上能被逐字节试探口令。
 */
public final class AdminGuard {

    private AdminGuard() {
    }

    public static void require(String authorizationHeader, AppProperties props) {
        String token = props.adminTokenOrNull();
        if (token == null) {
            if (props.adminTokenRequired()) {
                throw ApiException.unauthorized();
            }
            return;
        }
        String raw = authorizationHeader == null ? "" : authorizationHeader.replaceAll("(?i)^Bearer\\s+", "");
        if (!constantTimeEquals(token, raw.strip())) {
            throw ApiException.unauthorized();
        }
    }

    private static boolean constantTimeEquals(String expected, String actual) {
        byte[] a = expected.getBytes(StandardCharsets.UTF_8);
        byte[] b = actual.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(a, b);
    }
}
