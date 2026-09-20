package com.znwd.hostess.web;

import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
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

    @ExceptionHandler({MissingServletRequestParameterException.class, MethodArgumentNotValidException.class})
    public ResponseEntity<Map<String, Object>> handleBadRequest(Exception e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(com.znwd.hostess.http.ApiError.payload(
                        com.znwd.hostess.http.ApiError.VALIDATION_ERROR, "请求参数不合法", RequestId.current()));
    }

    @ExceptionHandler({NoHandlerFoundException.class, NoResourceFoundException.class})
    public ResponseEntity<Map<String, Object>> handleNotFound(Exception e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(com.znwd.hostess.http.ApiError.payload(
                        com.znwd.hostess.http.ApiError.NOT_FOUND, "接口不存在", RequestId.current()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleInternal(Exception e) {
        log.error("[api] 未处理异常 requestId={}", RequestId.current(), e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(com.znwd.hostess.http.ApiError.payload(
                        com.znwd.hostess.http.ApiError.INTERNAL_ERROR, "服务内部错误", RequestId.current()));
    }
}
