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

-- 只给这一个库的读写权限，够建表+读写会话/统计/反馈
GRANT ALL PRIVILEGES ON znwd.* TO 'znwd'@'localhost';
FLUSH PRIVILEGES;

-- 表结构由应用启动时执行 schema.sql（幂等）自动创建，这里不用手建。
-- 验证：
--   SELECT user, host FROM mysql.user WHERE user = 'znwd';
--   SHOW GRANTS FOR 'znwd'@'localhost';
