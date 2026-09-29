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
 * 反代侧仍建议再加一道 {@code client_max_body_size}（见 docs/deployment.md；语音接口要放到 2m）。
 */
@Component
@Order(2)
public class RequestSizeLimitFilter extends OncePerRequestFilter {

    /** 消息正文上限 2000 字（UTF-8 最多约 6KB），64KB 对合法请求宽裕得多 */
    public static final long MAX_BODY_BYTES = 64 * 1024;

    /**
     * 语音接口（录音上传）的上限：唯一允许超过 {@link #MAX_BODY_BYTES} 的路径。
     *
     * <p>16kHz/单声道/16bit 的 WAV 约 32KB/s，base64 之后还要再膨胀 4/3，64KB 连两秒录音都装不下。
     * 2MB 对应约 45 秒录音，而前端限时 20 秒，余量充足。
     *
     * <p>注意这是**硬上限**：{@code AUDIO_MAX_UPLOAD_BYTES} 配得比它大也没用，会先在这里被拒。
     */
    public static final long MAX_AUDIO_BODY_BYTES = 2 * 1024 * 1024;

    /** 语音接口路径前缀 */
    public static final String AUDIO_PATH_PREFIX = "/api/speech/";

    private final ObjectMapper mapper;

    public RequestSizeLimitFilter(ObjectMapper mapper) {
        this.mapper = mapper;
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

    /** 语音接口（录音上传）放宽到 {@link #MAX_AUDIO_BODY_BYTES}，其余路径一律 {@link #MAX_BODY_BYTES} */
    private static long limitFor(HttpServletRequest request) {
        String uri = request.getRequestURI();
        return uri != null && uri.startsWith(AUDIO_PATH_PREFIX) ? MAX_AUDIO_BODY_BYTES : MAX_BODY_BYTES;
    }
}
