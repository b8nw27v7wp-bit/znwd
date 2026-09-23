package com.znwd.hostess.knowledge;

/**
 * 向量索引状态（健康检查与 /api/knowledge/list 上报）。
 *
 * @param semantic       语义路<b>当下是否可用</b>（provider 支持语义 + 索引已就绪 + 没在降级 + 查询期没在失败），
 *                       不是「provider 是否具备语义能力」——只报能力会出现 health 说 true、mode 却一直是 keyword
 * @param degradedReason 语义路不可用的原因（构建/加载层面）；null = 正常
 * @param queryFailures  索引构建成功之后，查询期向量化失败的次数（外部服务中途不通的探测器）
 * @param lastQueryError 最近一次查询期失败的原因；null = 还没失败过
 */
public record VectorStats(
        String provider,
        boolean semantic,
        int dims,
        int vectors,
        String fingerprint,
        String indexFile,
        String degradedReason,
        int queryFailures,
        String lastQueryError) {
}
