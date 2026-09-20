package com.znwd.hostess.http;

import java.util.LinkedHashMap;
import java.util.Map;

import com.znwd.hostess.util.Hashing;

/**
 * 日志用的消息字段。
 *
 * <p>默认 hash：JSONL 日志是运营会拷走的文件，不该落盘参观者的完整提问；需要排查时把
 * LOG_MESSAGE_MODE 改成 preview。
 */
public final class MessageLog {

    private MessageLog() {
    }

    public static Map<String, Object> fields(String message, boolean previewMode) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (message == null || message.isEmpty()) {
            return out;
        }
        int len = message.length();
        if (previewMode) {
            out.put("messagePreview", message.substring(0, Math.min(80, len)));
        } else {
            out.put("messagePreview", Hashing.hashStr(message) + "#" + len + "#"
                    + message.substring(0, Math.min(20, len)));
        }
        out.put("messageLen", len);
        return out;
    }
}
