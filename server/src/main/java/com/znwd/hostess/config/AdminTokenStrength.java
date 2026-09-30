package com.znwd.hostess.config;

/**
 * 管理口令强度判断：**只用于启动告警**，不参与 {@code AdminGuard} 的鉴权判据
 * （改判据会把「已配口令的开发机」变成起不来，不该由强度检查承担）。
 */
public final class AdminTokenStrength {

    public static final int MIN_LENGTH = 16;

    private AdminTokenStrength() {
    }

    /**
     * @return true 表示口令明显偏弱（长度不足或等于常见示例值）；空/null 返回 false
     *         （那是 fail-closed 的另一种形态：没配口令时管理接口一律 401，日志另有就绪提示）
     */
    public static boolean isWeak(String token) {
        if (token == null || token.isBlank()) {
            return false;
        }
        String t = token.strip();
        if (t.length() < MIN_LENGTH) {
            return true;
        }
        String lower = t.toLowerCase();
        return lower.equals("changeme") || lower.equals("change_me") || lower.equals("password")
                || lower.equals("admin") || lower.equals("token") || lower.equals("root:123456");
    }
}
