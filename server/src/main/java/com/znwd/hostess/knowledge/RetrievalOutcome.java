package com.znwd.hostess.knowledge;

import java.util.List;

/**
 * 检索结果 + 诊断。
 *
 * @param hits 已按融合分降序、截断到 topK；闸门拦截时为空
 */
public record RetrievalOutcome(List<HybridHit> hits, RetrievalDiagnostics diagnostics) {
}
