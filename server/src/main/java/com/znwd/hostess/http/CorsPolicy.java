package com.znwd.hostess.http;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * CORS 策略：默认只放行本地开发源；生产用 CORS_ORIGINS 显式配置白名单。
 *
 * <p>HTTP 响应与 SSE 手写头共用同一策略，避免两套口径（老版本的 SSE 是手写头的，最容易漏）。
 */
public final class CorsPolicy {

    private static final Pattern DEV_ORIGIN =
            Pattern.compile("^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]|0\\.0\\.0\\.0)(:\\d+)?$");

    private CorsPolicy() {
    }

    /** @return 允许回显的 Origin；null 表示拒绝（不回 access-control-allow-origin） */
    public static String allowedOrigin(String origin, List<String> allow) {
        if (origin == null || origin.isBlank()) {
            return null;
        }
        String norm = origin.replaceAll("/$", "");
        if (!allow.isEmpty()) {
            return allow.contains("*") || allow.contains(norm) ? origin : null;
        }
        return DEV_ORIGIN.matcher(norm).matches() ? origin : null;
    }

    public static List<String> originsOf(String raw) {
        List<String> out = new ArrayList<>();
        if (raw == null || raw.isBlank()) {
            return out;
        }
        for (String part : raw.split("[,\\s]+")) {
            String trimmed = part.strip().replaceAll("/$", "");
            if (!trimmed.isEmpty()) {
                out.add(trimmed);
            }
        }
        return out;
    }
}
