package com.znwd.hostess.embedding;

/** 向量化失败（网关错误、条数不匹配等） */
public class EmbeddingException extends RuntimeException {

    public EmbeddingException(String message) {
        super(message);
    }

    public EmbeddingException(String message, Throwable cause) {
        super(message, cause);
    }
}
