package com.znwd.hostess.repository;

import java.sql.Connection;

import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.stereotype.Component;

/**
 * 数据库可用性状态 + 幂等建表（运行期可变）。
 *
 * <p>为什么不用 Spring 的 {@code spring.sql.init}：它在「连不上库」时不受 continue-on-error 保护，
 * 会直接把整个应用上下文打挂——展厅现场最怕的就是这个。所以建表放到这里，只有库可达时才执行。
 *
 * <p>展厅语义：库不可用时服务照常讲解，只是不落库；/api/health 会如实标出 storageAvailable=false。
 */
@Component
public class DatabaseStatus {

    private static final Logger log = LoggerFactory.getLogger(DatabaseStatus.class);

    /** 库不可用时两次重探之间的最小间隔：写路径靠它自动恢复，又不必每次写都等 connection-timeout */
    private static final long REPROBE_MS = 60_000L;

    private final HealthMapper healthMapper;
    private final DataSource dataSource;
    private volatile boolean available;
    private volatile String error;
    private volatile long lastCheckAt;

    public DatabaseStatus(HealthMapper healthMapper, DataSource dataSource) {
        this.healthMapper = healthMapper;
        this.dataSource = dataSource;
    }

    /** 探活 → 可达则建表（幂等）。返回库是否可用。 */
    public boolean check() {
        lastCheckAt = System.currentTimeMillis();
        try {
            healthMapper.ping();
        } catch (RuntimeException e) {
            available = false;
            error = rootMessage(e);
            return false;
        }
        available = true;
        error = null;
        migrateSchema();
        return true;
    }

    /** schema.sql 全是 CREATE TABLE IF NOT EXISTS，重复执行无副作用 */
    private void migrateSchema() {
        try {
            ResourceDatabasePopulator populator = new ResourceDatabasePopulator(new ClassPathResource("schema.sql"));
            populator.setContinueOnError(false);
            populator.setSeparator(";");
            populator.execute(dataSource);
        } catch (RuntimeException e) {
            available = false;
            error = rootMessage(e);
            log.warn("[db] 建表失败（表可能已存在或权限不足）：{}", error);
        }
    }

    public boolean available() {
        return available;
    }

    /**
     * 写路径用：现在值不值得尝试写库。
     *
     * <p>库已知不可用时直接返回 false —— 否则每次问答/反馈都要白等一次 Hikari
     * {@code connection-timeout}（实测 3 秒/次，展厅现场就是「问一句卡三秒」）。
     * 但也不能一票否决到底：最多每 60 秒重探一次，库恢复后自动接着落库。
     */
    public boolean shouldAttempt() {
        if (available) {
            return true;
        }
        if (System.currentTimeMillis() - lastCheckAt < REPROBE_MS) {
            return false;
        }
        return check();
    }

    public String error() {
        return error;
    }

    private static String rootMessage(Throwable t) {
        Throwable cur = t;
        while (cur.getCause() != null && cur.getCause() != cur) {
            cur = cur.getCause();
        }
        return cur.getMessage() == null ? cur.getClass().getSimpleName() : cur.getMessage();
    }

    /** 供运维排查：库地址（不含口令） */
    public String describe() {
        try (Connection conn = dataSource.getConnection()) {
            return conn.getMetaData().getURL();
        } catch (Exception e) {
            return "unavailable";
        }
    }
}
