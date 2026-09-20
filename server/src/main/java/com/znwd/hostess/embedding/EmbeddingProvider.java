package com.znwd.hostess.embedding;

import java.util.List;

/**
 * 向量化接口。可插拔：bag（离线特征哈希兜底）/ openai_compat（内网 embeddings 网关或云端）。
 */
public interface EmbeddingProvider {

    /** provider 名，用于向量索引文件名与健康检查上报 */
    String name();

    /** 向量维度；0 表示由服务端返回决定 */
    int dims();

    /**
     * 是否为语义向量：bag 特征哈希为 false（它的向量路只等于模糊关键词匹配，
     * 不能给「无关问题」兜底命中），openai_compat 为 true。
     */
    boolean semantic();

    List<float[]> embed(List<String> texts);
}
