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
                return blankAsUnset(super.getProperty(name));
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
                values.putAll(parse(path));
            } catch (IOException ignored) {
                // .env 可选：读不到就走 application.yml 默认值
            }
        }
        return values;
    }

    /**
     * 从 .env 文件解析键值对。包级可见，供单测直接指定临时文件。
     *
     * <p>处理行首 BOM（U+FEFF）：Java 的 {@code strip()} 按 {@code Character.isWhitespace}
     * 判定，U+FEFF 不属于空白字符，Windows 编辑器保存的 UTF-8 with BOM 会导致首行 key 静默失效。
     *
     * <p><b>值里的 # 原样保留，不剥行内注释</b>：注释只允许独占一行（行首 {@code #}）。
     * 这里曾把「空白后跟 #」当行内注释截断，于是 {@code DB_PASSWORD=abc #def} 的口令被静默截成
     * {@code abc}——现场表现是建库成功、连接全失败，极难排查。口令/URL 片段里出现 {@code #}
     * 是合法的，宁可让「想写行内注释的人」把注释挪到上一行（.env.example 就是这么写的：全部
     * 注释独占一行），也不再猜哪段是注释。
     */
    static Map<String, Object> parse(Path path) throws IOException {
        Map<String, Object> values = new LinkedHashMap<>();
        for (String rawLine : Files.readAllLines(path, StandardCharsets.UTF_8)) {
            String line = stripBom(rawLine).strip();
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
        return values;
    }

    /** 去掉行首 BOM（U+FEFF），只处理首字符，不触碰行中间的合法字符。 */
    private static String stripBom(String line) {
        return !line.isEmpty() && line.charAt(0) == '\uFEFF' ? line.substring(1) : line;
    }

    /**
     * 空值视为未配置（README / docs 同口径）：避免 .env 里 {@code LLM_BASE_URL=} 把
     * application.yml 的默认值覆盖成空串。包级可见，供单测直接断言。
     */
    static Object blankAsUnset(Object value) {
        return (value instanceof String s && s.isBlank()) ? null : value;
    }
}
