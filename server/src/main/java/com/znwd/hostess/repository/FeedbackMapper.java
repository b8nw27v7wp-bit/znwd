package com.znwd.hostess.repository;

import java.util.List;

import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import com.znwd.hostess.domain.FeedbackEntry;

/** 点赞/点踩落库。 */
@Mapper
public interface FeedbackMapper {

    @Insert("""
            INSERT INTO feedback (at, session_id, rating, question, comment)
            VALUES (#{at}, #{sessionId}, #{rating}, #{question}, #{comment})
            """)
    void insert(FeedbackEntry entry);

    @Select("""
            SELECT at, session_id, rating, question, comment
            FROM feedback ORDER BY id DESC LIMIT #{limit}
            """)
    List<FeedbackEntry> recent(@Param("limit") int limit);

    /** 保留最近 N 条，避免展厅半年后表无限增长 */
    @Delete("""
            DELETE FROM feedback WHERE id NOT IN (
              SELECT id FROM (SELECT id FROM feedback ORDER BY id DESC LIMIT #{keep}) t
            )
            """)
    int trim(@Param("keep") int keep);
}
