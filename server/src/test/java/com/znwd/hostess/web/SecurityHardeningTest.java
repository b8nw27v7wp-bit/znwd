package com.znwd.hostess.web;

import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import com.znwd.hostess.config.AdminTokenStrength;
import com.znwd.hostess.config.AppProperties;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 安全加固：统一响应头与弱管理口令告警。
 *
 * <p>这条钉的是「所有响应（含页面、错误、SSE、预检）都带同样的安全头」——
 * 老实现只有 nosniff，页面可被任意站点套 iframe。
 */
class SecurityHardeningTest {

    private static CorsAndIdFilter filter() {
        AppProperties props = mock(AppProperties.class);
        when(props.corsOriginList()).thenReturn(List.of());
        return new CorsAndIdFilter(props);
    }

    private static void assertHardeningHeaders(MockHttpServletResponse res) {
        assertEquals("nosniff", res.getHeader("x-content-type-options"));
        assertEquals("DENY", res.getHeader("x-frame-options"));
        assertEquals("no-referrer", res.getHeader("referrer-policy"));
        assertTrue(res.getHeader("x-request-id") != null && !res.getHeader("x-request-id").isBlank(),
                "每个响应都要带 x-request-id");
    }

    @Test
    @DisplayName("普通请求：nosniff + X-Frame-Options + Referrer-Policy + requestId 齐全")
    void headersOnNormalRequest() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/health");
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter().doFilter(request, response, new MockFilterChain());
        assertHardeningHeaders(response);
    }

    @Test
    @DisplayName("CORS 预检：同样带安全头（预检也是响应）")
    void headersOnPreflight() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("OPTIONS", "/api/chat");
        request.addHeader("Origin", "http://127.0.0.1:5173");
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter().doFilter(request, response, new MockFilterChain());
        assertHardeningHeaders(response);
        assertEquals(204, response.getStatus());
    }

    @Test
    @DisplayName("弱口令判定：短串/示例值算弱，长随机串不算，空值不告警")
    void weakTokenDetection() {
        assertTrue(AdminTokenStrength.isWeak("root:123456"));
        assertTrue(AdminTokenStrength.isWeak("short"));
        assertTrue(AdminTokenStrength.isWeak("changeme"));
        assertTrue(AdminTokenStrength.isWeak("0123456789abcde"));   // 15 位
        assertFalse(AdminTokenStrength.isWeak("0123456789abcdef")); // 16 位起不算弱
        assertFalse(AdminTokenStrength.isWeak("K7pQ2vB9xN4mR8sT1wY6zA3cD5eF7gH9"));
        assertFalse(AdminTokenStrength.isWeak(null));
        assertFalse(AdminTokenStrength.isWeak("   "));
    }
}
