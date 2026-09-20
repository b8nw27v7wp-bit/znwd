-- 展厅虚拟讲解员：MySQL 初始化（用 root 或管理员账号执行一次）
-- 用法：MySQL Workbench 打开本文件 → 改下面两处口令 → 点闪电执行；
--       或命令行：mysql -u root -p < server/db/init.sql
--
-- 目的：不要让应用用 root 连库。应用只拿 znwd 这个库的最小权限账号，
--      口令填到 server/.env 的 DB_PASSWORD（.env 不进版本库）。

CREATE DATABASE IF NOT EXISTS znwd
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

-- 把 CHANGE_ME_znwd 换成你自己的口令（两边保持一致）
CREATE USER IF NOT EXISTS 'znwd'@'localhost' IDENTIFIED BY 'CHANGE_ME_znwd';
ALTER USER 'znwd'@'localhost' IDENTIFIED BY 'CHANGE_ME_znwd';

-- 最小权限：只给这一个库，且只给应用真正用到的权限
--   SELECT/INSERT/UPDATE/DELETE —— 会话、问答日志、反馈、未覆盖问题的读写
--   CREATE —— 启动时幂等执行 schema.sql 建表（全是 CREATE TABLE IF NOT EXISTS）
-- 刻意不给 DROP/ALTER/LOCK TABLES/GRANT：应用用不到，真出事时也少一分破坏力。
-- 将来若要改表结构（需要 ALTER/DROP），临时执行一次：
--   GRANT ALTER, DROP ON znwd.* TO 'znwd'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE ON znwd.* TO 'znwd'@'localhost';
FLUSH PRIVILEGES;

-- 表结构由应用启动时执行 schema.sql（幂等）自动创建，这里不用手建。
-- 验证：
--   SELECT user, host FROM mysql.user WHERE user = 'znwd';
--   SHOW GRANTS FOR 'znwd'@'localhost';
