package com.znwd.hostess.repository;

import java.util.List;

import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import com.znwd.hostess.domain.UncoveredEntry;

/** 未覆盖问题清单落库（补资料的靶子）。 */
@Mapper
public interface UncoveredMapper {

    @Insert("""
            INSERT INTO uncovered_question (at, session_id, question)
            VALUES (#{at}, #{sessionId}, #{question})
            """)
    void insert(UncoveredEntry entry);

    @Select("""
            SELECT at, session_id, question FROM uncovered_question
            ORDER BY id DESC LIMIT #{limit}
            """)
    List<UncoveredEntry> latest(@Param("limit") int limit);

    @Delete("""
            DELETE FROM uncovered_question WHERE id NOT IN (
              SELECT id FROM (SELECT id FROM uncovered_question ORDER BY id DESC LIMIT #{keep}) t
            )
            """)
    int trim(@Param("keep") int keep);
}
