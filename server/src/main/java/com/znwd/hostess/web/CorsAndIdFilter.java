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

        String origin = request.getHeader("origin");
        String allowed = CorsPolicy.allowedOrigin(origin, allowOrigins);
        response.setHeader("vary", "Origin");
        if (allowed != null) {
            response.setHeader("access-control-allow-origin", allowed);
            response.setHeader("access-control-allow-credentials", "true");
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
