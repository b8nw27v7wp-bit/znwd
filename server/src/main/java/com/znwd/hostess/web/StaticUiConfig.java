package com.znwd.hostess.web;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URL;
import java.nio.channels.ReadableByteChannel;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.Path;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.resource.HttpResource;
import org.springframework.web.servlet.resource.NoResourceFoundException;
import org.springframework.web.servlet.resource.PathResourceResolver;

import com.znwd.hostess.config.AppProperties;

/**
 * jar 直接托管前端产物（整机部署：页面与 /api 同源，免静态服务器、免 CORS）。
 *
 * <p>只在 {@link AppProperties#webDistDirPath()} 下存在 {@code index.html} 时注册 {@code /**}
 * 资源映射；否则只保留 {@link SpaIndexController} 的首页兜底（它自己按目录是否存在决定 404），
 * 保持「未知路由 → JSON 404 信封」的现状（开发时前端跑 Vite dev）。
 *
 * <p>资源解析的两条底线：
 * <ul>
 *   <li>{@code /api/} 与 {@code /actuator} 前缀一律不解析（返回 null），继续走
 *       {@link GlobalExceptionHandler} 的 JSON 404——绝不能把接口路径回落成 200 的 index.html，
 *       否则前端会把 HTML 当接口数据；</li>
 *   <li>其它找不到的路径回落 index.html（SPA 的 history 路由可以直接刷新/直达）。</li>
 * </ul>
 *
 * <p>首页 {@code /} 不走资源处理器：{@code /**} 落在根路径时 pathWithinMapping 是空串，
 * Spring 会在进解析器前就按无效输入路径忽略（见 ResourceHandlerUtils.shouldIgnoreInputPath），
 * Boot 自己也是靠 WelcomePageHandlerMapping 兜的；这里由 {@link SpaIndexController} 直接返回 index.html。
 */
@Configuration
public class StaticUiConfig implements WebMvcConfigurer {

    private static final Logger log = LoggerFactory.getLogger(StaticUiConfig.class);

    private final AppProperties props;

    public StaticUiConfig(AppProperties props) {
        this.props = props;
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        Path dir = props.webDistDirPath();
        if (!Files.isRegularFile(dir.resolve("index.html"))) {
            log.info("[ui] 未托管前端（{} 下没有 index.html）：/ 与 SPA 路由继续走 JSON 404；开发时用 Vite dev", dir);
            return;
        }
        String location = dir.toUri().toString();
        if (!location.endsWith("/")) {
            location += "/";
        }
        registry.addResourceHandler("/**")
                .addResourceLocations(location)
                .resourceChain(false)
                .addResolver(new SpaFallbackResolver());
        log.info("[ui] 已托管前端产物 {}（/api、/actuator 仍走 JSON 404；其余未知路径回落 index.html）", dir);
    }

    /** 是否接口前缀（传给解析器的 resourcePath 不含开头的 /） */
    static boolean isApiOrActuator(String resourcePath) {
        return resourcePath.equals("api") || resourcePath.startsWith("api/")
                || resourcePath.equals("actuator") || resourcePath.startsWith("actuator/");
    }

    /** SPA 资源解析：具体文件照常返回；前端路由回退 index.html；接口前缀直接 null。 */
    static final class SpaFallbackResolver extends PathResourceResolver {

        @Override
        protected Resource getResource(String resourcePath, Resource location) throws IOException {
            if (isApiOrActuator(resourcePath)) {
                return null;
            }
            if (!resourcePath.isEmpty() && !"index.html".equals(resourcePath)) {
                Resource direct = super.getResource(resourcePath, location);
                if (direct != null) {
                    return direct;
                }
            }
            Resource index = super.getResource("index.html", location);
            return index == null ? null : new NoCacheResource(index);
        }
    }

    /** index.html 必须 no-cache：重新部署后浏览器要立刻拿到新的资源引用（带哈希的 assets 不动） */
    static final class NoCacheResource implements HttpResource {

        private final Resource delegate;

        NoCacheResource(Resource delegate) {
            this.delegate = delegate;
        }

        @Override
        public HttpHeaders getResponseHeaders() {
            HttpHeaders headers = new HttpHeaders();
            headers.setCacheControl(CacheControl.noCache());
            return headers;
        }

        @Override
        public boolean exists() {
            return delegate.exists();
        }

        @Override
        public boolean isReadable() {
            return delegate.isReadable();
        }

        @Override
        public boolean isOpen() {
            return delegate.isOpen();
        }

        @Override
        public boolean isFile() {
            return delegate.isFile();
        }

        @Override
        public URL getURL() throws IOException {
            return delegate.getURL();
        }

        @Override
        public URI getURI() throws IOException {
            return delegate.getURI();
        }

        @Override
        public File getFile() throws IOException {
            return delegate.getFile();
        }

        @Override
        public ReadableByteChannel readableChannel() throws IOException {
            return delegate.readableChannel();
        }

        @Override
        public byte[] getContentAsByteArray() throws IOException {
            return delegate.getContentAsByteArray();
        }

        @Override
        public String getContentAsString(Charset charset) throws IOException {
            return delegate.getContentAsString(charset);
        }

        @Override
        public long contentLength() throws IOException {
            return delegate.contentLength();
        }

        @Override
        public long lastModified() throws IOException {
            return delegate.lastModified();
        }

        @Override
        public Resource createRelative(String relativePath) throws IOException {
            return delegate.createRelative(relativePath);
        }

        @Override
        public String getFilename() {
            return delegate.getFilename();
        }

        @Override
        public String getDescription() {
            return delegate.getDescription();
        }

        @Override
        public InputStream getInputStream() throws IOException {
            return delegate.getInputStream();
        }
    }

    /**
     * 首页兜底：{@code /**} 资源处理器够不到根路径（根路径的 pathWithinMapping 是空串，
     * 框架在进解析器之前就忽略掉了），这里直接返回 index.html。
     *
     * <p>目录或文件不存在时抛 {@link NoResourceFoundException}，继续由
     * {@link GlobalExceptionHandler} 回统一 404 信封——开发态（没有前端产物）行为不变。
     */
    @Controller
    static class SpaIndexController {

        private final AppProperties props;

        SpaIndexController(AppProperties props) {
            this.props = props;
        }

        @GetMapping("/")
        ResponseEntity<Resource> index() throws NoResourceFoundException {
            Path index = props.webDistDirPath().resolve("index.html");
            if (!Files.isRegularFile(index)) {
                throw new NoResourceFoundException(HttpMethod.GET, "/");
            }
            return ResponseEntity.ok()
                    .contentType(MediaType.TEXT_HTML)
                    .cacheControl(CacheControl.noCache())
                    .body(new FileSystemResource(index));
        }
    }
}
