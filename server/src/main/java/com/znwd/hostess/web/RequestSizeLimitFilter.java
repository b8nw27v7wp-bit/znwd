package com.znwd.hostess.web;

import java.io.IOException;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.znwd.hostess.config.AppProperties;
import com.znwd.hostess.http.ApiError;

/**
 * 请求体大小上限。
 *
 * <p>消息正文在 {@code RequestParser} 里会被截到 2000 字，但那是「已经读进内存之后」的事：
 * 一个几十兆的 JSON 仍然会先占满堆再被拒。展厅前端是固定的一套页面，写请求都是小 JSON，
 * 这里直接按 {@code Content-Length} 拦掉超限的请求，成本极低。
 *
 * <p>没有 {@code Content-Length} 的写请求（分块传输）无法判定大小，一律按超限处理——
 * 合法调用方都会带长度，放行反而是绕过口子（语音接口也一样，录音是先编码好再整体 POST 的）。
 * 反代侧仍建议再加一道 {@code client_max_body_size}（见 docs/deployment.md；语音接口要放到 3m）。
 */
@Component
@Order(2)
public class RequestSizeLimitFilter extends OncePerRequestFilter {

    /** 消息正文上限 2000 字（UTF-8 最多约 6KB），64KB 对合法请求宽裕得多 */
    public static final long MAX_BODY_BYTES = 64 * 1024;

    /** JSON 壳（`{"audio":"data:audio/wav;base64,` 与收尾）的长度余量，给得宽一点 */
    public static final long JSON_SHELL_SLACK = 1024;

    /**
     * 语音路径请求体上限在**缺省配置**下的值（= `AUDIO_MAX_UPLOAD_BYTES` 缺省 2MB 推出来的数）。
     *
     * <p>运行时用的是 {@link #audioBodyLimit()}——它跟着 `AUDIO_MAX_UPLOAD_BYTES` 走，
     * 这个常量只是「缺省时等于多少」，供测试当缺省口径的锚点。
     */
    public static final long DEFAULT_AUDIO_BODY_BYTES = (2 * 1024 * 1024) / 3 * 4 + JSON_SHELL_SLACK;

    /** 语音接口路径前缀 */
    public static final String AUDIO_PATH_PREFIX = "/api/speech/";

    private final ObjectMapper mapper;
    private final AppProperties props;

    public RequestSizeLimitFilter(ObjectMapper mapper, AppProperties props) {
        this.mapper = mapper;
        this.props = props;
    }

    /**
     * 语音接口（录音上传）的请求体上限：**由 `AUDIO_MAX_UPLOAD_BYTES` 推出来**，不再另写一个数。
     *
     * <p>为什么不能直接拿那个值当请求体上限：录音是 base64 传的（膨胀 4/3）外加一层 JSON 壳，
     * 解码后 2MB 的 WAV 在请求体里约 2.67MB。早先两个数各写各的、都叫 2MB，效果是
     * **`AUDIO_MAX_UPLOAD_BYTES` 调大也无效**——请求先在这里被 413 拒掉，而文档还写着
     * 「识别上传上限（解码后的 WAV 字节）」，运维照着调只会拿到一个「上限 2048KB」的 413。
     *
     * <p>下限是 {@link #MAX_BODY_BYTES}：这道闸门是粗过滤器，只负责「别让超大请求进内存」；
     * 具体哪一项超了由 {@code SpeechParser} 给带细节的 4xx（它会说清是 WAV 太大还是字段不对）。
     */
    long audioBodyLimit() {
        return Math.max(MAX_BODY_BYTES, props.audioMaxUploadBytes() / 3 * 4 + JSON_SHELL_SLACK);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        long limit = limitFor(request);
        if (hasBody(request) && !withinLimit(request, limit)) {
            response.setStatus(413);
            response.setContentType("application/json;charset=UTF-8");
            response.getWriter().write(mapper.writeValueAsString(ApiError.payload(
                    ApiError.PAYLOAD_TOO_LARGE,
                    "请求体过大（上限 " + (limit / 1024) + "KB）",
                    RequestId.current())));
            return;
        }
        chain.doFilter(request, response);
    }

    /** 只有写方法才带业务请求体；GET/DELETE 等无体方法不参与判定 */
    private static boolean hasBody(HttpServletRequest request) {
        String method = request.getMethod();
        return "POST".equalsIgnoreCase(method) || "PUT".equalsIgnoreCase(method)
                || "PATCH".equalsIgnoreCase(method);
    }

    private static boolean withinLimit(HttpServletRequest request, long limit) {
        long declared = request.getContentLengthLong();
        return declared >= 0 && declared <= limit;
    }

    /** 语音接口（录音上传）按 {@link #audioBodyLimit()} 放宽，其余路径一律 {@link #MAX_BODY_BYTES} */
    private long limitFor(HttpServletRequest request) {
        String uri = request.getRequestURI();
        return uri != null && uri.startsWith(AUDIO_PATH_PREFIX) ? audioBodyLimit() : MAX_BODY_BYTES;
    }
}
