package com.znwd.hostess.config;

import java.io.InputStream;
import java.lang.reflect.RecordComponent;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 配置接线守卫：{@link AppProperties} 的每个顶层字段都必须在 application.yml 的 znwd 段里有对应键。
 *
 * <p>为什么需要：{@code @ConfigurationProperties} 是按「键名」做 relaxed binding 的。record 里声明了字段、
 * yml 里却没写那个键时，字段静默为 null/false/0，代码里依赖它的规则会一声不响地失效——编译、启动、
 * 其余单测全都不报错。已经踩过一次：{@code nodeEnv} 只写了 {@code node-env} 才会绑上，而现场配的是
 * {@code NODE_ENV}，于是「生产未配管理口令必须 401」这条安全规则静默失效。
 */
class AppPropertiesBindingTest {

    @Test
    void AppProperties的每个字段都在applicationYml里有对应键() throws Exception {
        String yml = readApplicationYml();
        List<String> keys = znwdSectionKeys(yml);

        List<String> missing = new ArrayList<>();
        for (RecordComponent component : AppProperties.class.getRecordComponents()) {
            String key = toKebabCase(component.getName());
            if (!keys.contains(key)) {
                missing.add(key + "（字段 " + component.getName() + "）");
            }
        }
        assertTrue(missing.isEmpty(),
                "以下配置字段在 application.yml 的 znwd 段里没有键，绑定会静默失效：" + missing);
    }

    @Test
    void NODE_ENV绑定到node_env键() throws Exception {
        String yml = readApplicationYml();
        assertTrue(yml.contains("node-env: ${NODE_ENV:}"),
                "NODE_ENV 必须显式绑到 znwd.node-env，否则生产强制管理口令的规则失效");
    }

    @Test
    void 未配置管理口令时默认强制鉴权() throws Exception {
        assertTrue(readApplicationYml().contains("require-admin-token: ${REQUIRE_ADMIN_TOKEN:true}"),
                "默认必须要求 ADMIN_TOKEN；同机反向代理无法靠 localAddr 判断真实来源");
    }

    @Test
    void Prompt的每个字段都在applicationYml的prompt段里有对应键() throws Exception {
        List<String> keys = sectionKeys(readApplicationYml(), "prompt");

        List<String> missing = new ArrayList<>();
        for (RecordComponent component : AppProperties.Prompt.class.getRecordComponents()) {
            String key = toKebabCase(component.getName());
            if (!keys.contains(key)) {
                missing.add(key + "（字段 " + component.getName() + "）");
            }
        }
        assertTrue(missing.isEmpty(),
                "以下 Prompt 配置字段在 application.yml 的 znwd.prompt 段里没有键，绑定会静默失效：" + missing);
    }

    @Test
    void Prompt配置项绑到PROMPT环境变量占位符() throws Exception {
        String yml = readApplicationYml();
        assertTrue(yml.contains("system-path: ${PROMPT_SYSTEM_PATH:}"),
                "znwd.prompt.system-path 必须绑 PROMPT_SYSTEM_PATH");
        assertTrue(yml.contains("no-hit-hint-path: ${PROMPT_NO_HIT_HINT_PATH:}"),
                "znwd.prompt.no-hit-hint-path 必须绑 PROMPT_NO_HIT_HINT_PATH");
        assertTrue(yml.contains("no-hit-reply-path: ${PROMPT_NO_HIT_REPLY_PATH:}"),
                "znwd.prompt.no-hit-reply-path 必须绑 PROMPT_NO_HIT_REPLY_PATH");
    }

    @Test
    void Prompt路径通过relaxed绑定到record字段() {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("znwd.prompt.system-path", "/etc/prompt/system.txt");
        values.put("znwd.prompt.no-hit-hint-path", "/etc/prompt/hint.txt");
        values.put("znwd.prompt.no-hit-reply-path", "/etc/prompt/reply.txt");

        AppProperties props = new Binder(new MapConfigurationPropertySource(values))
                .bind("znwd", AppProperties.class).get();

        assertNotNull(props.prompt());
        assertEquals("/etc/prompt/system.txt", props.prompt().systemPath());
        assertEquals("/etc/prompt/hint.txt", props.prompt().noHitHintPath());
        assertEquals("/etc/prompt/reply.txt", props.prompt().noHitReplyPath());
    }

    /**
     * 语音（`znwd.audio`）同理：这一段的键最多，而且几乎每个都是「配错了会静默按缺省跑」的类型
     * ——比如两个超时预算是「一次调用含重试」的总时长，键名写错就退回缺省值，
     * 表现成现场怎么调都不生效。
     */
    @Test
    void Audio的每个字段都在applicationYml的audio段里有对应键() throws Exception {
        List<String> keys = sectionKeys(readApplicationYml(), "audio");

        List<String> missing = new ArrayList<>();
        for (RecordComponent component : AppProperties.Audio.class.getRecordComponents()) {
            String key = toKebabCase(component.getName());
            if (!keys.contains(key)) {
                missing.add(key + "（字段 " + component.getName() + "）");
            }
        }
        assertTrue(missing.isEmpty(),
                "以下 Audio 配置字段在 application.yml 的 znwd.audio 段里没有键，绑定会静默失效：" + missing);
    }

    /** 两个超时预算的 relaxed 绑定：键名、record 字段名、访问器三者必须对上 */
    @Test
    void Audio超时预算通过relaxed绑定到record字段() {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("znwd.audio.provider", "mimo");
        values.put("znwd.audio.timeout-ms", "9000");
        values.put("znwd.audio.asr-timeout-ms", "21000");

        AppProperties props = new Binder(new MapConfigurationPropertySource(values))
                .bind("znwd", AppProperties.class).get();

        assertNotNull(props.audio());
        assertEquals(9_000, props.audio().timeoutMs());
        assertEquals(21_000, props.audio().asrTimeoutMs());
        assertEquals(9_000, props.audioTimeoutMs(), "访问器必须原样带出配置值");
        assertEquals(21_000, props.audioAsrTimeoutMs());
    }

    /**
     * 两个超时预算的**缺省值**也是承重的：它们规定了服务端一次调用（含全部重试）的最坏耗时，
     * 必须短于客户端的等待上限（合成 20s、整段识别 90s），否则浏览器一放弃，服务端还在替一个
     * 没人要的响应花线程与上游配额。改这两个数要连着前端那一侧一起看。
     */
    @Test
    void 未配置语音时超时预算取缺省值() {
        // 至少要有一个键，Binder 才会真的去构造这个 record（空源会报「No value bound」）
        AppProperties props = new Binder(new MapConfigurationPropertySource(Map.of("znwd.node-env", "production")))
                .bind("znwd", AppProperties.class).get();

        assertTrue(props.audioTimeoutMs() <= 20_000,
                "合成预算必须 ≤ 前端的 SYNTH_TIMEOUT_MS（20s），实际 " + props.audioTimeoutMs());
        assertTrue(props.audioAsrTimeoutMs() <= 90_000,
                "识别预算必须 ≤ 前端的 RECOGNITION_TIMEOUT_MS（90s），实际 " + props.audioAsrTimeoutMs());
        assertEquals(15_000, props.audioTimeoutMs(), "缺省值写死在文档与 .env.example 里，改动要三处同步");
        assertEquals(30_000, props.audioAsrTimeoutMs(), "缺省值写死在文档与 .env.example 里，改动要三处同步");
    }

    /** 取 application.yml 里 znwd.<section>: 段的直接子键（4 空格缩进） */
    private static List<String> sectionKeys(String yml, String section) {
        List<String> keys = new ArrayList<>();
        boolean inside = false;
        for (String raw : yml.split("\n")) {
            String line = raw.stripTrailing();
            if (line.isEmpty() || line.stripLeading().startsWith("#")) {
                continue;
            }
            int indent = line.length() - line.stripLeading().length();
            if (indent == 2 && line.strip().equals(section + ":")) {
                inside = true;
                continue;
            }
            if (indent <= 2) {
                inside = false;
                continue;
            }
            if (inside && indent == 4) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    keys.add(line.substring(0, colon).strip());
                }
            }
        }
        return keys;
    }

    private static String readApplicationYml() throws Exception {
        try (InputStream in = AppPropertiesBindingTest.class.getClassLoader().getResourceAsStream("application.yml")) {
            assertNotNull(in, "application.yml 不在测试类路径上");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /** 取 application.yml 里 znwd: 段的直接子键（不含注释与嵌套段的孙键） */
    private static List<String> znwdSectionKeys(String yml) {
        List<String> keys = new ArrayList<>();
        boolean inZnwd = false;
        for (String raw : yml.split("\n")) {
            String line = raw.stripTrailing();
            if (line.isEmpty() || line.stripLeading().startsWith("#")) {
                continue;
            }
            if (!line.startsWith(" ")) {
                inZnwd = line.startsWith("znwd:");
                continue;
            }
            if (!inZnwd || line.startsWith("    ")) {   // 4 空格缩进 = 嵌套段（llm/embed 的子键）
                continue;
            }
            int colon = line.indexOf(':');
            if (colon > 0) {
                keys.add(line.substring(0, colon).strip());
            }
        }
        return keys;
    }

    /** knowledgeDir -> knowledge-dir（Spring 的 relaxed binding 写法） */
    private static String toKebabCase(String name) {
        return name.replaceAll("([a-z0-9])([A-Z])", "$1-$2").toLowerCase();
    }
}
