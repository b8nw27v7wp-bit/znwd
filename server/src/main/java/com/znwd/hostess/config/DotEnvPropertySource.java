package com.znwd.hostess.config;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.StandardEnvironment;

/**
 * 把 server/.env 读成 Spring 配置源。
 *
 * <p>为什么需要：老后端（Node 版）的全部可调项都在 {@code server/.env}，运维与展厅现场已经按那个文件
 * 操作。改成纯 application.yml 会让已有的 .env 失效（密钥还得进仓库），所以这里让 .env 继续生效。
 *
 * <p>优先级：系统环境变量 &gt; .env &gt; application.yml 默认值。这样现场临时 {@code set LLM_MODEL=...}
 * 能压过文件，而文件能压过代码默认值——与原有行为一致。
 */
public class DotEnvPropertySource implements EnvironmentPostProcessor {

    /** 相对工作目录的文件名；部署时若在仓库根启动也能命中 server/.env */
    private static final String[] CANDIDATES = {"server/.env", ".env"};

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        Map<String, Object> values = readDotEnv();
        if (values.isEmpty()) {
            return;
        }
        MapPropertySource source = new MapPropertySource("znwdDotEnv", values) {
            @Override
            public Object getProperty(String name) {
                // 空值视为未配置：避免 .env 里 `LLM_BASE_URL=` 把默认值覆盖成空串
                Object value = super.getProperty(name);
                return (value instanceof String s && s.isBlank()) ? null : value;
            }
        };
        environment.getPropertySources()
                .addAfter(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME, source);
    }

    private Map<String, Object> readDotEnv() {
        Map<String, Object> values = new LinkedHashMap<>();
        for (String candidate : CANDIDATES) {
            Path path = Path.of(candidate);
            if (!Files.isRegularFile(path)) {
                continue;
            }
            try {
                for (String rawLine : Files.readAllLines(path, StandardCharsets.UTF_8)) {
                    String line = rawLine.strip();
                    if (line.isEmpty() || line.startsWith("#")) {
                        continue;
                    }
                    int eq = line.indexOf('=');
                    if (eq <= 0) {
                        continue;
                    }
                    String key = line.substring(0, eq).strip();
                    String value = line.substring(eq + 1).strip();
                    if (value.length() >= 2
                            && ((value.startsWith("\"") && value.endsWith("\""))
                                || (value.startsWith("'") && value.endsWith("'")))) {
                        value = value.substring(1, value.length() - 1);
                    }
                    values.put(key, value);
                }
            } catch (IOException ignored) {
                // .env 可选：读不到就走 application.yml 默认值
            }
        }
        return values;
    }
}
