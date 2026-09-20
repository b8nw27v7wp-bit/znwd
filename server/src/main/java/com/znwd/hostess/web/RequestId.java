package com.znwd.hostess.web;

import jakarta.servlet.http.HttpServletRequest;

import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/** 当前请求的 requestId（由 RequestIdFilter 写入请求属性）。 */
public final class RequestId {

    public static final String ATTRIBUTE = "znwd.requestId";

    private RequestId() {
    }

    public static String current() {
        if (RequestContextHolder.getRequestAttributes() instanceof ServletRequestAttributes attrs) {
            HttpServletRequest request = attrs.getRequest();
            Object value = request.getAttribute(ATTRIBUTE);
            return value == null ? "" : value.toString();
        }
        return "";
    }
}
