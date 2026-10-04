package com.znwd.hostess.config;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * .env 值保留策略回归测试。
 *
 * <p>核心回归：值里的 {@code #} 不再被当行内注释截断。曾发生过
 * {@code DB_PASSWORD=abc #def} 的口令被静默截成 {@code abc}（建库成功、连接全失败），
 * 根因就是 {@code stripInlineComment} 按「空白后跟 #」剥值。
 *
 * <p>现行约定（与 .env.example 一致）：注释必须独占一行，值 = 后原样保留（仅去首尾空白、
 * 按需去成对引号）。空值仍视为未配置（README / docs 同口径）。
 */
class DotEnvValueTest {

    @TempDir
    Path tempDir;

    private Map<String, Object> parse(String content) throws IOException {
        Path envFile = tempDir.resolve(".env");
        Files.writeString(envFile, content, StandardCharsets.UTF_8);
        return DotEnvPropertySource.parse(envFile);
    }

    /** 值里含「空格 + #」不能被截断：口令/base64/URL 片段里 # 是合法字符 */
    @Test
    void valueWithSpaceHashIsKeptIntact() throws IOException {
        Map<String, Object> values = parse("DB_PASSWORD=abc #def\n");

        assertEquals("abc #def", values.get("DB_PASSWORD"));
    }

    /** 值以 # 结尾、或中间带 #，同样原样保留（去首尾空白后） */
    @Test
    void valueEndingWithHashAndHashInsideAreKept() throws IOException {
        Map<String, Object> values = parse("LLM_MODEL=mimo-v2.5 #备注\n"
                + "LLM_API_KEY=sk-123#456\n"
                + "PROMPT_TAIL=结束#\n");

        assertEquals("mimo-v2.5 #备注", values.get("LLM_MODEL"));
        assertEquals("sk-123#456", values.get("LLM_API_KEY"));
        assertEquals("结束#", values.get("PROMPT_TAIL"));
    }

    /** 行首注释（含缩进过的）仍然整行忽略，不能因此变成一个 key */
    @Test
    void fullLineCommentsAreStillSkipped() throws IOException {
        Map<String, Object> values = parse("# DB_PASSWORD=整行注释\n"
                + "    # 缩进的注释行 FOO=bar\n"
                + "REAL_KEY=yes\n");

        assertFalse(values.containsKey("DB_PASSWORD"));
        assertFalse(values.containsKey("FOO"));
        assertFalse(values.keySet().stream().anyMatch(k -> k.contains("整行注释")));
        assertEquals("yes", values.get("REAL_KEY"));
        assertEquals(1, values.size());
    }

    /** 空值解析为 ""，由 blankAsUnset 判为未配置（不覆盖 application.yml 默认值） */
    @Test
    void emptyValueIsTreatedAsUnset() throws IOException {
        Map<String, Object> values = parse("LLM_BASE_URL=\n"
                + "DB_PASSWORD=   \n");

        assertEquals("", values.get("LLM_BASE_URL"));
        assertEquals("", values.get("DB_PASSWORD"));
        assertNull(DotEnvPropertySource.blankAsUnset(""));
        assertNull(DotEnvPropertySource.blankAsUnset("   "));
        assertNull(DotEnvPropertySource.blankAsUnset(null));
        // 非空值必须原样可用：不能把「有值」也误判成未配置
        assertEquals("x", DotEnvPropertySource.blankAsUnset("x"));
        assertEquals(" #", DotEnvPropertySource.blankAsUnset(" #"));
    }

    /** 引号包裹的值仍去掉引号（引号是值的一部分还是定界符，与旧行为一致） */
    @Test
    void quotedValueStillStripsQuotes() throws IOException {
        Map<String, Object> values = parse("LLM_MODEL=\"mimo-v2.5\"\n"
                + "AUDIO_VOICE='冰糖'\n");

        assertEquals("mimo-v2.5", values.get("LLM_MODEL"));
        assertEquals("冰糖", values.get("AUDIO_VOICE"));
    }

    /** 值里的第一个 = 之后全算值（LLM_EXTRA_BODY 这类 JSON 就是这么存的） */
    @Test
    void valueKeepsSubsequentEquals() throws IOException {
        Map<String, Object> values = parse("LLM_EXTRA_BODY={\"thinking\":{\"type\":\"disabled\"}}\n");

        assertEquals("{\"thinking\":{\"type\":\"disabled\"}}", values.get("LLM_EXTRA_BODY"));
        assertTrue(values.containsKey("LLM_EXTRA_BODY"));
    }
}
