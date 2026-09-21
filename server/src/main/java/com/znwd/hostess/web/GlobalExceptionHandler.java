package com.znwd.hostess.web;

import java.io.IOException;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/**
 * 统一错误信封：{@code {error, message, requestId}}。
 *
 * <p>两件事必须守住：5xx 一律只回「服务内部错误」（细节进日志，别把 Java 异常名丢给展厅大屏），
 * 404 也走同一信封（不然框架默认体暴露实现）。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<Map<String, Object>> handleApi(ApiException e) {
        return ResponseEntity.status(e.status())
                .body(com.znwd.hostess.http.ApiError.payload(e.code(), e.getMessage(), RequestId.current(), e.extra()));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> handleUnreadable(HttpMessageNotReadableException e) {
        // 请求体不是合法 JSON。别复用 chat 的文案（"message is required"），
        // 否则 /api/feedback 收到坏 body 时会把排查方向指错。
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(com.znwd.hostess.http.ApiError.payload(
                        com.znwd.hostess.http.ApiError.VALIDATION_ERROR, "请求体不是合法 JSON 对象", RequestId.current()));
    }

    @ExceptionHandler({MissingServletRequestParameterException.class, MethodArgumentNotValidException.class,
            MethodArgumentTypeMismatchException.class})
    public ResponseEntity<Map<String, Object>> handleBadRequest(Exception e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(com.znwd.hostess.http.ApiError.payload(
                        com.znwd.hostess.http.ApiError.VALIDATION_ERROR, "请求参数不合法", RequestId.current()));
    }

    /**
     * 方法不对（例如 PUT /api/chat）：必须是 405，不能掉进下面的兜底 500。
     *
     * <p>这条是边界测试打出来的：`@ExceptionHandler(Exception.class)` 会把
     * {@code HttpRequestMethodNotSupportedException} 一起兜住，于是「用错方法」被报成
     * 「服务内部错误」——客户端以为服务挂了，运维还得去翻日志才发现是自己发错了。
     */
    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<Map<String, Object>> handleMethodNotAllowed(HttpRequestMethodNotSupportedException e) {
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)
                .body(com.znwd.hostess.http.ApiError.payload(
                        com.znwd.hostess.http.ApiError.METHOD_NOT_ALLOWED, "请求方法不支持", RequestId.current(),
                        java.util.Map.of("allowed", e.getSupportedMethods() == null
                                ? java.util.List.of() : java.util.Arrays.asList(e.getSupportedMethods()))));
    }

    /** 请求体的 Content-Type 不支持 → 415，同样别掉进 500 */
    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<Map<String, Object>> handleMediaType(HttpMediaTypeNotSupportedException e) {
        return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE)
                .body(com.znwd.hostess.http.ApiError.payload(
                        com.znwd.hostess.http.ApiError.UNSUPPORTED_MEDIA_TYPE, "请求内容类型不支持", RequestId.current()));
    }

    @ExceptionHandler({NoHandlerFoundException.class, NoResourceFoundException.class})
    public ResponseEntity<Map<String, Object>> handleNotFound(Exception e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(com.znwd.hostess.http.ApiError.payload(
                        com.znwd.hostess.http.ApiError.NOT_FOUND, "接口不存在", RequestId.current()));
    }

    /**
     * 客户端提前断开（关页面 / 切网络 / 展厅闲置复位时前端 abort）——不是服务端故障。
     *
     * <p>为什么必须单独接住：SSE 的响应头已经是 {@code text/event-stream}，兜底 handler 想写
     * JSON 错误信封时会再抛 {@code HttpMessageNotWritableException}，容器随后再记两条 ERROR，
     * 于是一次「访客关掉页面」在日志里变成 3 个 ERROR + 上百行堆栈（边界测试 tools/security.py 的
     * G06/G07 就是这么抓到的）。这里只记一行 INFO，且**不带响应体**——能走到这里说明对端已经没了，
     * 回什么都不重要，重要的是别再往下抛。
     */
    @ExceptionHandler({IOException.class, AsyncRequestNotUsableException.class})
    public ResponseEntity<Void> handleClientGone(Exception e) {
        log.info("[api] 客户端提前断开（可能是访客关页面或刷新）：{}", e.getClass().getSimpleName());
        return ResponseEntity.ok().build();
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleInternal(Exception e) {
        log.error("[api] 未处理异常 requestId={}", RequestId.current(), e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(com.znwd.hostess.http.ApiError.payload(
                        com.znwd.hostess.http.ApiError.INTERNAL_ERROR, "服务内部错误", RequestId.current()));
    }
}
