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
 * 本服务没有任何上传接口，合法调用方都会带长度，放行反而是绕过口子。
 * 反代侧仍建议再加一道 {@code client_max_body_size 64k}（见 docs/deployment.md）。
 */
@Component
@Order(2)
public class RequestSizeLimitFilter extends OncePerRequestFilter {

    /** 消息正文上限 2000 字（UTF-8 最多约 6KB），64KB 对合法请求宽裕得多 */
    public static final long MAX_BODY_BYTES = 64 * 1024;

    private final ObjectMapper mapper;

    public RequestSizeLimitFilter(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (hasBody(request) && !withinLimit(request)) {
            response.setStatus(413);
            response.setContentType("application/json;charset=UTF-8");
            response.getWriter().write(mapper.writeValueAsString(ApiError.payload(
                    ApiError.PAYLOAD_TOO_LARGE,
                    "请求体过大（上限 " + (MAX_BODY_BYTES / 1024) + "KB）",
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

    private static boolean withinLimit(HttpServletRequest request) {
        long declared = request.getContentLengthLong();
        return declared >= 0 && declared <= MAX_BODY_BYTES;
    }
}
