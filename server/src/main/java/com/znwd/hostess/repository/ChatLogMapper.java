package com.znwd.hostess.repository;

import java.util.List;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import com.znwd.hostess.domain.ChatLogEntry;

/** 问答日志落库（统计与排查的数据来源）。 */
@Mapper
public interface ChatLogMapper {

    @Insert("""
            INSERT INTO chat_log (at, session_id, mode, provider, message_preview, message_len, answer_preview,
                                  latency_ms, no_hit, retrieval, rewritten, error,
                                  prompt_tokens, completion_tokens, reasoning_tokens, total_tokens)
            VALUES (#{at}, #{sessionId}, #{mode}, #{provider}, #{messagePreview}, #{messageLen}, #{answerPreview},
                    #{latencyMs}, #{noHit}, #{retrieval}, #{rewritten}, #{error},
                    #{usage.promptTokens}, #{usage.completionTokens}, #{usage.reasoningTokens},
                    #{usage.totalTokens})
            """)
    void insert(ChatLogEntry entry);

    @Select("""
            SELECT
              COUNT(*)                                                       AS chatTotal,
              COALESCE(SUM(mode = 'rag'), 0)                                 AS ragHits,
              COALESCE(SUM(no_hit = 1), 0)                                   AS noHits,
              COALESCE(SUM(rewritten = 1), 0)                                AS rewritten,
              COALESCE(SUM(error IS NOT NULL), 0)                            AS errors,
              COALESCE(SUM(prompt_tokens), 0)                                AS promptTokens,
              COALESCE(SUM(completion_tokens), 0)                            AS completionTokens,
              COALESCE(SUM(reasoning_tokens), 0)                             AS reasoningTokens,
              COALESCE(SUM(total_tokens), 0)                                 AS totalTokens,
              COALESCE(SUM(prompt_tokens IS NOT NULL), 0)                    AS tokenCalls
            FROM chat_log
            """)
    Counters counters();

    @Select("""
            SELECT at, session_id, mode, no_hit, message_preview, latency_ms, error
            FROM chat_log ORDER BY id DESC LIMIT #{limit}
            """)
    List<RecentChatRow> recent(@Param("limit") int limit);

    record Counters(long chatTotal, long ragHits, long noHits, long rewritten, long errors,
                    long promptTokens, long completionTokens, long reasoningTokens, long totalTokens,
                    long tokenCalls) {
    }

    record RecentChatRow(long at, String sessionId, String mode, boolean noHit, String messagePreview,
                         long latencyMs, String error) {
    }
}
