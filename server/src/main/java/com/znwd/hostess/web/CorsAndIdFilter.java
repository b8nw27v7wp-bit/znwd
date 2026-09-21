package com.znwd.hostess.web;

import java.io.IOException;
import java.util.List;
import java.util.UUID;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import com.znwd.hostess.config.AppProperties;
import com.znwd.hostess.http.CorsPolicy;

/**
 * CORS 白名单 + 请求 ID。
 *
 * <p>HTTP 响应与 SSE 走同一个策略实现：老版本 SSE 是手写头的，最容易出现「普通接口放行了、流式接口没放行」。
 * 预检请求直接在这里应答，不进入业务。
 */
@Component
@Order(1)
public class CorsAndIdFilter extends OncePerRequestFilter {

    private final List<String> allowOrigins;

    public CorsAndIdFilter(AppProperties props) {
        this.allowOrigins = props.corsOriginList();
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String requestId = UUID.randomUUID().toString().substring(0, 8);
        request.setAttribute(RequestId.ATTRIBUTE, requestId);
        response.setHeader("x-request-id", requestId);
        // 让浏览器不要"猜"内容类型：JSON 就只当 JSON。所有响应（含错误与 SSE）统一带上，
        // 万一将来某条响应被拼进了 HTML 片段，浏览器也不会把它当页面解析。
        response.setHeader("x-content-type-options", "nosniff");

        String origin = request.getHeader("origin");
        String allowed = CorsPolicy.allowedOrigin(origin, allowOrigins);
        response.setHeader("vary", "Origin");
        if (allowed != null) {
            response.setHeader("access-control-allow-origin", allowed);
            // 刻意不发 access-control-allow-credentials：本服务不用 cookie 认证，管理口令走
            // Authorization 头（不需要这个头）。而 CORS_ORIGINS=* 时会回显任意 Origin，
            // 若同时声明允许携带凭据就是经典的错配。
        }
        if ("OPTIONS".equalsIgnoreCase(request.getMethod())) {
            response.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
            response.setHeader("access-control-allow-headers", "content-type,authorization");
            response.setHeader("access-control-max-age", "600");
            response.setStatus(HttpServletResponse.SC_NO_CONTENT);
            return;
        }
        chain.doFilter(request, response);
    }
}
