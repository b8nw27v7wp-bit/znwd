package com.znwd.hostess;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * 产品展厅 AI 虚拟讲解员后端。
 *
 * <p>能力：Hybrid RAG 检索（关键词 bigram+IDF 与语义向量 RRF 融合 + 相关性闸门）、
 * 多轮指代改写、SSE 流式回答、会话/统计/反馈落库（MySQL）、知识热重载。
 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
public class HostessApplication {

    public static void main(String[] args) {
        SpringApplication.run(HostessApplication.class, args);
    }
}
