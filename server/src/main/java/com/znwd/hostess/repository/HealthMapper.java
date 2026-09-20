package com.znwd.hostess.repository;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

/** 数据库可用性探针：健康检查与启动日志用它，而不是靠「有没有异常」猜。 */
@Mapper
public interface HealthMapper {

    @Select("SELECT 1")
    int ping();
}
