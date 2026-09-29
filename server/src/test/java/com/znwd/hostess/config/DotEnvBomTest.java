package com.znwd.hostess.config;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DotEnv BOM 首行失效回归测试。
 *
 * <p>Windows 编辑器（含 PowerShell 5.1）保存 UTF-8 with BOM 时，文件首行会带 U+FEFF。
 * Java 的 {@code strip()} 按 {@code Character.isWhitespace} 判定，U+FEFF 不是空白，
 * 导致首行 key 静默失效（变成 "\uFEFFKEY=val"，Spring 读不到）。
 *
 * <p>变异验证：注释掉 {@code stripBom} 调用后本测试必须红。
 */
class DotEnvBomTest {

    @TempDir
    Path tempDir;

    /** 首行带 BOM + CRLF + 引号值 + 行尾注释：必须正确解析出所有键 */
    @Test
    void bomFirstLineShouldParseCorrectly() throws IOException {
        // 构造带 BOM 的 .env 内容：首行 key 故意放在 BOM 之后
        String envContent = "\uFEFFLLM_API_KEY=sk-test-123\r\n"
                + "LLM_MODEL=\"mimo-v2.5\"\r\n"
                + "# 注释行\r\n"
                + "AUDIO_VOICE='冰糖'  # 行尾注释\r\n";

        Path envFile = tempDir.resolve(".env");
        Files.writeString(envFile, envContent, StandardCharsets.UTF_8);

        Map<String, Object> result = DotEnvPropertySource.parse(envFile);

        // 首行 key 必须被正确解析（变异验证核心断言）
        assertTrue(result.containsKey("LLM_API_KEY"),
                "BOM 导致首行 key 失效：LLM_API_KEY 应被解析但未出现，key 集合=" + result.keySet());
        assertEquals("sk-test-123", result.get("LLM_API_KEY"));

        // 其余行也正常解析
        assertEquals("mimo-v2.5", result.get("LLM_MODEL"));
        assertEquals("冰糖", result.get("AUDIO_VOICE"));
    }

    /** 无 BOM 时行为不变（回归保护） */
    @Test
    void noBomShouldWorkAsBefore() throws IOException {
        String envContent = "LLM_API_KEY=sk-clean\r\n"
                + "LLM_MODEL=bare\r\n";

        Path envFile = tempDir.resolve(".env");
        Files.writeString(envFile, envContent, StandardCharsets.UTF_8);

        Map<String, Object> result = DotEnvPropertySource.parse(envFile);

        assertEquals("sk-clean", result.get("LLM_API_KEY"));
        assertEquals("bare", result.get("LLM_MODEL"));
    }

    /** 空文件不应抛异常 */
    @Test
    void emptyFileShouldReturnEmpty() throws IOException {
        Path envFile = tempDir.resolve(".env");
        Files.writeString(envFile, "", StandardCharsets.UTF_8);

        Map<String, Object> result = DotEnvPropertySource.parse(envFile);
        assertTrue(result.isEmpty());
    }

    /** 只有 BOM 没有实际内容：不应报错 */
    @Test
    void bomOnlyFileShouldReturnEmpty() throws IOException {
        Path envFile = tempDir.resolve(".env");
        Files.writeString(envFile, "\uFEFF", StandardCharsets.UTF_8);

        Map<String, Object> result = DotEnvPropertySource.parse(envFile);
        assertTrue(result.isEmpty());
    }
}
