package com.znwd.hostess.util;

/** 32 位 FNV 变体哈希，用于日志脱敏与向量索引指纹（与旧 TS 版同算法，保证指纹可复现）。 */
public final class Hashing {

    private Hashing() {
    }

    public static String hashStr(String s) {
        int h1 = 0x811c9dc5;
        int h2 = 0x01000193;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            h1 ^= c;
            h1 *= 0x01000193;
            h2 = (h2 + c * 31) | 0;
        }
        return Integer.toUnsignedString(h1, 16) + "-" + Integer.toUnsignedString(h2, 16);
    }
}
