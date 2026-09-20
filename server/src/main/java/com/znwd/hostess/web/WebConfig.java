package com.znwd.hostess.web;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.TaskExecutor;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/**
 * Web 层配置。
 *
 * <p>SSE 需要一个独立线程池：模型流式调用会阻塞线程，用 Tomcat 的工作线程会被慢慢耗光
 * （展厅同时开几块屏就会看到「点了没反应」）。
 */
@Configuration
public class WebConfig {

    @Bean("sseExecutor")
    public TaskExecutor sseExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(16);
        executor.setQueueCapacity(64);
        executor.setThreadNamePrefix("sse-");
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(5);
        executor.initialize();
        return executor;
    }

    /** SSE 心跳线程（长连接保活，与业务线程池分开，避免心跳被流式调用挤住） */
    @Bean(destroyMethod = "shutdown")
    public ScheduledExecutorService sseHeartbeat() {
        return Executors.newScheduledThreadPool(2, r -> {
            Thread t = new Thread(r, "sse-heartbeat");
            t.setDaemon(true);
            return t;
        });
    }
}
