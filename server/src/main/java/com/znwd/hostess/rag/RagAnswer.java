package com.znwd.hostess.rag;

import java.util.List;

import com.znwd.hostess.knowledge.RetrievalDiagnostics;
import com.znwd.hostess.llm.LlmUsage;

/**
 * 一次问答的完整结果。
 *
 * @param noHit     相关性闸门拦截：本次回答没有任何知识片段支撑
 * @param rewrite   多轮指代改写信息（检索用改写后的查询，回答仍按原问题）
 * @param diagnostics 检索诊断（模式、闸门原因、分数余量）
 */
public record RagAnswer(
        String answer,
        List<RagSource> sources,
        String mode,
        String provider,
        String retrieval,
        boolean noHit,
        RetrievalDiagnostics diagnostics,
        RewriteResult rewrite,
        LlmUsage usage) {

    public static final String MODE_RAG = "rag";
    public static final String MODE_LLM_ONLY = "llm_only";
    /** 闸门拦截走固定回复，没有调用大模型 */
    public static final String PROVIDER_GATE = "gate";
}
