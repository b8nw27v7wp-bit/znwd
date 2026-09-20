package com.znwd.hostess.repository;

import java.util.List;

import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/** 会话与消息落库（展厅每天开关机，会话不该因为重启全丢）。 */
@Mapper
public interface SessionMapper {

    @Insert("""
            INSERT INTO session (id, created_at, last_active) VALUES (#{id}, #{createdAt}, #{lastActive})
            ON DUPLICATE KEY UPDATE last_active = VALUES(last_active)
            """)
    void upsertSession(@Param("id") String id, @Param("createdAt") long createdAt, @Param("lastActive") long lastActive);

    @Insert("""
            INSERT INTO session_message (session_id, seq, role, content) VALUES (#{sessionId}, #{seq}, #{role}, #{content})
            """)
    void insertMessage(@Param("sessionId") String sessionId, @Param("seq") int seq,
                       @Param("role") String role, @Param("content") String content);

    @Select("""
            SELECT id, created_at, last_active FROM session
            WHERE last_active >= #{since} ORDER BY last_active DESC LIMIT #{limit}
            """)
    List<SessionRow> recentSessions(@Param("since") long since, @Param("limit") int limit);

    @Select("""
            SELECT role, content FROM session_message WHERE session_id = #{sessionId} ORDER BY seq
            """)
    List<MessageRow> messages(@Param("sessionId") String sessionId);

    @Delete("DELETE FROM session_message WHERE session_id = #{sessionId}")
    int deleteMessages(@Param("sessionId") String sessionId);

    @Delete("DELETE FROM session WHERE id = #{sessionId}")
    int deleteSession(@Param("sessionId") String sessionId);

    @Delete("DELETE FROM session_message WHERE session_id IN (SELECT id FROM session WHERE last_active < #{before})")
    int deleteExpiredMessages(@Param("before") long before);

    @Delete("DELETE FROM session WHERE last_active < #{before}")
    int deleteExpiredSessions(@Param("before") long before);

    record SessionRow(String id, long createdAt, long lastActive) {
    }

    record MessageRow(String role, String content) {
    }
}
