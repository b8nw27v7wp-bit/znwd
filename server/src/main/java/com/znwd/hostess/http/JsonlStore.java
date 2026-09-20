package com.znwd.hostess.http;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * JSONL 事件日志（问答/反馈/错误），超过阈值按天轮转。
 *
 * <p>写盘放在单线程队列里：日志不该拖慢回答，但进程退出时必须 flush——丢了日志等于运营拿不到
 * 「哪些问题没人答上来」。
 */
public class JsonlStore {

    private static final Logger log = LoggerFactory.getLogger(JsonlStore.class);

    private final Path file;
    private final String baseName;
    private final long maxBytes;
    private final boolean previewMode;
    private final ObjectMapper mapper;
    private final ExecutorService writer =
            Executors.newSingleThreadExecutor(r -> {
                Thread t = new Thread(r, "jsonl-writer");
                t.setDaemon(true);
                return t;
            });

    public JsonlStore(Path dataDir, String baseName, long maxBytes, boolean previewMode, ObjectMapper mapper) {
        this.baseName = baseName;
        this.file = dataDir.resolve(baseName + ".jsonl");
        this.maxBytes = maxBytes;
        this.previewMode = previewMode;
        this.mapper = mapper;
    }

    public Path path() {
        return file;
    }

    /** 日志消息模式：true = 落 80 字预览，false = 落 hash（默认，避免把访客原话写进运维文件） */
    public boolean previewMode() {
        return previewMode;
    }

    /** 写入前脱敏：message 字段换成 hash/preview + 长度 */
    public Map<String, Object> prepare(Map<String, Object> obj) {
        Map<String, Object> rest = new LinkedHashMap<>(obj);
        Object message = rest.remove("message");
        if (message instanceof String s && !rest.containsKey("messagePreview")) {
            rest.putAll(MessageLog.fields(s, previewMode));
        }
        rest.putIfAbsent("at", System.currentTimeMillis());
        return rest;
    }

    public void append(Map<String, Object> obj) {
        Map<String, Object> payload = prepare(obj);
        writer.execute(() -> write(payload));
    }

    private void write(Map<String, Object> payload) {
        try {
            String line = mapper.writeValueAsString(payload) + "\n";
            Files.createDirectories(file.getParent());
            rotateIfNeeded();
            Files.writeString(file, line, StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException | RuntimeException e) {
            log.warn("[jsonl] 写入 {} 失败：{}", file, e.getMessage());
        }
    }

    private void rotateIfNeeded() throws IOException {
        if (!Files.isRegularFile(file) || Files.size(file) < maxBytes) {
            return;
        }
        String day = LocalDate.now().toString();
        Path target = file.resolveSibling(baseName + "." + day + ".jsonl");
        int n = 0;
        while (Files.exists(target)) {
            n++;
            target = file.resolveSibling(baseName + "." + day + "." + n + ".jsonl");
        }
        Files.move(file, target);
    }

    public void flush() {
        writer.shutdown();
        try {
            writer.awaitTermination(3, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
