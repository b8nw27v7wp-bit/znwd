package com.znwd.hostess.web;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.support.StaticApplicationContext;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockServletContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.accept.ContentNegotiationManager;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.handler.AbstractHandlerMapping;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import com.znwd.hostess.config.AppProperties;

import static org.hamcrest.Matchers.containsString;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * jar 托管前端产物的契约测试（整机部署形态：页面与 /api 同源）。
 *
 * <p>三条必须钉住的边界：
 * <ul>
 *   <li>环境里没有前端产物（开发机/CI）时完全不注册资源映射，接口保持 JSON 404；</li>
 *   <li>有产物时 {@code /} 与任意 SPA 路由返回 index.html，具体静态文件照常返回；</li>
 *   <li>{@code /api/}、{@code /actuator} 前缀**不得**回落 index.html（前端会把 200 的 HTML
 *       当成接口数据），必须继续走统一 404 信封。</li>
 * </ul>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK,
        properties = {"znwd.llm.provider=mock", "znwd.embed.provider=bag"})
@AutoConfigureMockMvc
class StaticUiConfigTest {

    private static final String INDEX_HTML =
            "<!doctype html><html><body><div id=\"app\">SPA-INDEX-MARKER</div></body></html>";

    @TempDir
    static Path distDir;

    @Autowired
    MockMvc mvc;

    @DynamicPropertySource
    static void webDistDir(DynamicPropertyRegistry registry) {
        registry.add("znwd.web-dist-dir", distDir::toString);
    }

    @BeforeAll
    static void writeFrontendArtifacts() throws Exception {
        Files.writeString(distDir.resolve("index.html"), INDEX_HTML, StandardCharsets.UTF_8);
        Files.createDirectories(distDir.resolve("assets"));
        Files.writeString(distDir.resolve("assets/app.js"), "console.log('app');", StandardCharsets.UTF_8);
    }

    @Test
    void 根路径返回index_html且no_cache() throws Exception {
        mvc.perform(get("/"))
                .andExpect(status().isOk())
                .andExpect(content().string(containsString("SPA-INDEX-MARKER")))
                .andExpect(header().string("Cache-Control", containsString("no-cache")));
    }

    @Test
    void 具体静态资源按原文件返回() throws Exception {
        mvc.perform(get("/assets/app.js"))
                .andExpect(status().isOk())
                .andExpect(content().string(containsString("console.log")));
    }

    @Test
    void 未知前端路由回落index_html() throws Exception {
        mvc.perform(get("/some/spa/route"))
                .andExpect(status().isOk())
                .andExpect(content().string(containsString("SPA-INDEX-MARKER")));
    }

    @Test
    void 未知api路径仍是统一404信封不回落index() throws Exception {
        mvc.perform(get("/api/does-not-exist"))
                .andExpect(status().isNotFound())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.error").value("not_found"));
    }

    @Test
    void 未知actuator路径仍是统一404信封不回落index() throws Exception {
        mvc.perform(get("/actuator/does-not-exist"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("not_found"));
    }

    @Test
    void 目录不存在时不注册任何资源处理器(@TempDir Path base) {
        AppProperties props = propsWithWebDist(base.resolve("absent").toString());
        assertNull(new ProbeRegistry().build(props),
                "目录不存在时必须完全不注册资源映射，未知路由保持原有 JSON 404");
    }

    @Test
    void 目录不存在时首页抛NoResourceFound走统一404信封(@TempDir Path base) {
        AppProperties props = propsWithWebDist(base.resolve("absent").toString());
        NoResourceFoundException e = assertThrows(NoResourceFoundException.class,
                () -> new StaticUiConfig.SpaIndexController(props).index());
        assertEquals("/", e.getResourcePath());
    }

    private static AppProperties propsWithWebDist(String dir) {
        Map<String, Object> values = Map.of("znwd.web-dist-dir", dir);
        return new Binder(new MapConfigurationPropertySource(values)).bind("znwd", AppProperties.class).get();
    }

    /** 把 protected 的 getHandlerMapping 暴露出来：null = 一个资源处理器都没注册 */
    static final class ProbeRegistry extends ResourceHandlerRegistry {

        ProbeRegistry() {
            super(new StaticApplicationContext(), new MockServletContext(), new ContentNegotiationManager());
        }

        AbstractHandlerMapping build(AppProperties props) {
            new StaticUiConfig(props).addResourceHandlers(this);
            return getHandlerMapping();
        }
    }
}
