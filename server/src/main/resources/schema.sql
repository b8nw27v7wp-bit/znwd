-- 展厅虚拟讲解员：会话与运营数据（MySQL 8+ / 9.x，utf8mb4）
-- 设计取向：内存仍然是热路径（问答不因数据库慢而卡），这些表负责「重启不丢」与运营留痕。

CREATE TABLE IF NOT EXISTS session (
  id          VARCHAR(64)  NOT NULL COMMENT '会话 ID（仅 A-Za-z0-9._-）',
  created_at  BIGINT       NOT NULL COMMENT '创建时间（epoch ms）',
  last_active BIGINT       NOT NULL COMMENT '最后活跃时间（epoch ms），过期即清理',
  PRIMARY KEY (id),
  KEY idx_session_last_active (last_active)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT '展厅会话';

CREATE TABLE IF NOT EXISTS session_message (
  id         BIGINT      NOT NULL AUTO_INCREMENT,
  session_id VARCHAR(64) NOT NULL,
  seq        INT         NOT NULL COMMENT '会话内序号，用于恢复顺序',
  role       VARCHAR(16) NOT NULL COMMENT 'user / assistant / system',
  content    MEDIUMTEXT  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_session_message (session_id, seq)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT '会话消息';

CREATE TABLE IF NOT EXISTS chat_log (
  id                BIGINT       NOT NULL AUTO_INCREMENT,
  at                BIGINT       NOT NULL COMMENT '请求开始时间（epoch ms）',
  session_id        VARCHAR(64)  NULL,
  mode              VARCHAR(16)  NOT NULL COMMENT 'rag / llm_only',
  provider          VARCHAR(64)  NOT NULL COMMENT 'mock / openai_compat / gate',
  message_preview   VARCHAR(255) NULL COMMENT '默认 hash 形态，不含明文',
  message_len       INT          NULL,
  answer_preview    VARCHAR(255) NULL,
  latency_ms        INT          NOT NULL DEFAULT 0,
  no_hit            TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '相关性闸门拦截（知识库未覆盖）',
  retrieval         VARCHAR(16)  NULL COMMENT 'keyword / hybrid（如实上报）',
  rewritten         TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '多轮指代改写是否生效',
  error             VARCHAR(64)  NULL,
  prompt_tokens     INT          NULL,
  completion_tokens INT          NULL,
  reasoning_tokens  INT          NULL COMMENT '>0 说明模型思考模式没关，成本会翻倍',
  total_tokens      INT          NULL,
  PRIMARY KEY (id),
  KEY idx_chat_log_at (at),
  KEY idx_chat_log_session (session_id),
  KEY idx_chat_log_no_hit (no_hit)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT '问答日志（统计与踩点排查）';

CREATE TABLE IF NOT EXISTS feedback (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  at         BIGINT       NOT NULL,
  session_id VARCHAR(64)  NULL,
  rating     VARCHAR(8)   NOT NULL COMMENT 'up / down',
  question   VARCHAR(255) NULL COMMENT '问题摘要（缺省时服务端取会话最后一问）',
  comment    VARCHAR(512) NULL,
  PRIMARY KEY (id),
  KEY idx_feedback_at (at),
  KEY idx_feedback_rating (rating)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT '访客反馈';

CREATE TABLE IF NOT EXISTS uncovered_question (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  at         BIGINT       NOT NULL,
  session_id VARCHAR(64)  NULL,
  question   VARCHAR(512) NOT NULL COMMENT '闸门拦截的原始提问：下一批要补的知识',
  PRIMARY KEY (id),
  KEY idx_uncovered_at (at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT '知识库未覆盖问题';
