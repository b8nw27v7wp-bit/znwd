package com.znwd.hostess.web;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import com.fasterxml.jackson.databind.ObjectMapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 请求体大小上限：超限写请求必须在进业务之前被拒，且不得因为「没有 Content-Length」而绕过。 */
class RequestSizeLimitFilterTest {

    private final RequestSizeLimitFilter filter = new RequestSizeLimitFilter(new ObjectMapper());

    @Test
    void 超过上限的请求体被拒且不进业务链路() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/chat");
        request.setContent(new byte[(int) RequestSizeLimitFilter.MAX_BODY_BYTES + 1]);
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, response, chain);

        assertEquals(413, response.getStatus());
        String body = response.getContentAsString();
        assertTrue(body.contains("payload_too_large"), "必须是统一错误信封：" + body);
        assertTrue(body.contains("requestId"), "错误信封要带 requestId：" + body);
        assertNull(chain.getRequest(), "被拒的请求不得进入后续链路");
    }

    @Test
    void 恰好等于上限的请求放行() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/chat");
        request.setContent(new byte[(int) RequestSizeLimitFilter.MAX_BODY_BYTES]);
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, response, chain);

        assertEquals(200, response.getStatus());
        assertNotNull(chain.getRequest(), "边界内的请求应当继续处理");
    }

    @Test
    void 无ContentLength的写请求按超限处理() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/chat");
        // 不设 content：MockHttpServletRequest 的 getContentLength() 返回 -1，
        // 即分块传输那种「无法判定大小」的情形
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(request, response, new MockFilterChain());

        assertEquals(413, response.getStatus(), "无法判定大小就不能放行，否则是个绕过口子");
    }

    @Test
    void 无请求体的读方法与预检请求不受影响() throws Exception {
        for (String method : new String[] {"GET", "OPTIONS", "DELETE"}) {
            MockHttpServletRequest request = new MockHttpServletRequest(method, "/api/health");
            request.setContent(new byte[(int) RequestSizeLimitFilter.MAX_BODY_BYTES * 100]);
            MockHttpServletResponse response = new MockHttpServletResponse();
            MockFilterChain chain = new MockFilterChain();

            filter.doFilter(request, response, chain);

            assertEquals(200, response.getStatus(), method + " 不带业务请求体，不该被拦");
            assertNotNull(chain.getRequest());
        }
    }

    @Test
    void 语音接口放到录音上限否则两秒都录不了() throws Exception {
        // 16kHz WAV 约 32KB/s，base64 再膨胀 4/3：按 64KB 卡的话半秒就超
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/speech/recognize");
        request.setContent(new byte[(int) RequestSizeLimitFilter.MAX_BODY_BYTES + 32 * 1024]);
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, response, chain);

        assertEquals(200, response.getStatus(), "语音路径应当放行");
        assertNotNull(chain.getRequest(), "放行的请求要继续进业务链路");
    }

    @Test
    void 语音接口自己也有硬上限() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/speech/recognize");
        request.setContent(new byte[(int) RequestSizeLimitFilter.MAX_AUDIO_BODY_BYTES + 1]);
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, response, chain);

        assertEquals(413, response.getStatus(), "放宽不等于不设限");
        assertTrue(response.getContentAsString().contains("payload_too_large"));
        assertNull(chain.getRequest());
    }

    @Test
    void 语音路径的前缀匹配不会误伤同名开头的其它路径() throws Exception {
        // /api/speechy 不是语音接口：前缀匹配必须带斜杠，否则是个绕过 64KB 的口子
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/speechy");
        request.setContent(new byte[(int) RequestSizeLimitFilter.MAX_BODY_BYTES + 1]);
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(request, response, new MockFilterChain());

        assertEquals(413, response.getStatus());
    }
}
