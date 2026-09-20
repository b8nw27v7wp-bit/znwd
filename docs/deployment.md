# 部署与运维（展厅 / 一体机）

产物：后端 `server/target/hostess-server.jar`（Spring Boot 可执行 jar）+ 前端静态文件 `web/dist`。
数据库：MySQL 8+（**可选**——不可用时服务照常讲解，只是不落库）。

## 1. 部署形态

```
展厅一体机（或后台电脑）
├── hostess-server.jar        监听 HOST:PORT（默认 127.0.0.1:8787）
├── web/dist/                 静态文件（任意静态服务器/Nginx，或 vite preview 自查）
├── knowledge/                知识正文（必须与 jar 同机可读，路径由 KNOWLEDGE_DIR 指定）
├── server/data/              events.jsonl 日志（DATA_DIR）
└── server/indexes/           向量索引（INDEX_DIR，可重建，丢了会自动重建）
```

- **默认只监听本机**（`HOST=127.0.0.1`）。展厅内网跨机访问要显式改 `HOST=0.0.0.0`，并限制防火墙或经反向代理暴露；生产必须同时配 `ADMIN_TOKEN`。
- 前端 dev/preview 由 Vite 把 `/api` 代理到 `VITE_API_TARGET`（默认 `http://127.0.0.1:8787`）；SSE 会被强制 `no-cache, no-transform`，否则看不到逐字输出。
- 展厅现场自查：`npm run build && npm run preview`（`:4173`，同样代理 `/api`），不必装 Nginx。

## 2. 构建

```bash
# 后端（在仓库根）
cd server && ../tools/mvn -B -DskipTests package     # → server/target/hostess-server.jar

# 前端
cd web && npm ci && npm run build                    # → web/dist
```

## 3. 环境变量

全部键名以 `server/src/main/resources/application.yml` 为准；模板见 `server/.env.example`。
读取优先级：**系统环境变量 > `server/.env` > `application.yml` 默认值**（`.env` 里空值视为未配置）。

### HTTP 与鉴权

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。展厅内网需 `0.0.0.0`（并配防火墙/反代） |
| `PORT` | `8787` | 监听端口 |
| `ADMIN_TOKEN` | 空 | 管理接口 Bearer 口令。**生产必须设置** |
| `REQUIRE_ADMIN_TOKEN` | `false` | `true` 时未配 token 的管理接口直接 401 |
| `NODE_ENV` | 空 | `production`/`prod`/`staging` 时强制管理口令 |
| `CORS_ORIGINS` | 空 | 逗号分隔白名单（可含 `*`）。**空 = 只放行 localhost/127.0.0.1/[::1]/0.0.0.0**，生产必须显式配 |
| `CHAT_RATE_PER_MIN` | `30` | 每 IP 每分钟问答上限 |

### MySQL

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DB_HOST` | `127.0.0.1` | 库地址 |
| `DB_PORT` | `3306` | 端口 |
| `DB_NAME` | `znwd` | 库名 |
| `DB_USER` | `znwd` | 应用账号（**不要用 root**） |
| `DB_PASSWORD` | 空 | 与 `init.sql` 里设置的口令一致 |
| `DB_POOL_SIZE` | `8` | Hikari 连接池上限 |

### 检索与知识库

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KNOWLEDGE_DIR` | `./knowledge` | 知识正文目录（相对仓库根或绝对路径） |
| `INDEX_DIR` | `./server/indexes` | 向量索引目录（可删，会自动重建） |
| `DATA_DIR` | `./server/data` | JSONL 日志目录 |
| `MIN_RELEVANCE_SCORE` | `6.3` | 相关性闸门阈值（标定得出，改语料后必须重标） |
| `MIN_VECTOR_SCORE` | `0.35` | 语义向量兜底阈值 |
| `ANSWER_CACHE_SIZE` | `200` | 答案缓存条数 |
| `UNCOVERED_LOG_SIZE` | `50` | 未覆盖问题留存条数（0 = 关闭） |
| `NO_HIT_LLM` | `false` | 闸门拦截时是否仍让模型生成拒答（默认固定文案、0 token） |
| `KNOWLEDGE_WATCH` | `false` | 监听知识目录热更新（Windows 上不稳定，生产用手动 reload） |

### 模型与日志

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LLM_PROVIDER` | `mock` | `mock` \| `openai_compat` |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 空 | OpenAI 兼容网关 |
| `LLM_EXTRA_BODY` | 空 | 合并进请求体；MiMo 必须 `{"thinking":{"type":"disabled"}}` |
| `LLM_MAX_TOKENS` | `0` | 输出上限（0 = 不限），成本闸门 |
| `LLM_MAX_RETRIES` / `LLM_RETRY_BASE_MS` | `2` / `1000` | 过载重试与退避 |
| `LLM_TIMEOUT_MS` / `LLM_STREAM_TIMEOUT_MS` | `90000` / `180000` | 单次调用预算（含重试） |
| `EMBED_PROVIDER` | `bag` | `bag`（无语义）\| `openai_compat`（真语义，需 reload 重建索引） |
| `EMBED_BASE_URL` / `EMBED_API_KEY` / `EMBED_MODEL` | 空 | 内网 embeddings |
| `LOG_MAX_BYTES` | `5000000` | `events.jsonl` 轮转阈值 |
| `LOG_MESSAGE_MODE` | `hash` | `hash`（只落 hash + 20 字前缀）\| `preview`（落 80 字预览） |

## 4. MySQL 初始化

```bash
# 1) 改 server/db/init.sql 里两处 CHANGE_ME_znwd（改成同一个自定口令）
# 2) 用管理员账号执行一次（命令行或 MySQL Workbench 打开后执行）
mysql -u root -p < server/db/init.sql
# 3) 把同一口令写进 server/.env
DB_PASSWORD=<上一步的口令>
```

`init.sql` 只做三件事：建库 `znwd`、建最小权限账号 `znwd@localhost`、授权该库读写。**表结构不用手建**——应用启动时 `DatabaseStatus` 在库可达的情况下幂等执行 `schema.sql`（五张表：`session`、`session_message`、`chat_log`、`feedback`、`uncovered_question`）。

判断当前是否连着库：`GET /api/health` 的 `storageAvailable`（`false` = 没连上，服务仍在讲解但不落库，前端顶部显示橙色降级横幅）。

## 5. 运维接口

| 接口 | 鉴权 | 用途 |
| --- | --- | --- |
| `GET /api/health` | 无 | 版本、知识块数、检索模式与阈值、`storageAvailable`、CORS 白名单、运行时长 |
| `GET /api/health/summary` | 无 | 零敏感摘要：问答总数、未覆盖数、活跃会话、检索模式 |
| `GET /api/stats` | 有 | 累计统计、token 用量、反馈计数（落库，重启不清零） |
| `GET /api/admin/uncovered` | 有 | 未覆盖问题清单（补资料的靶子） |
| `GET /api/admin/feedback-stats?format=csv` | 有 | 反馈汇总 / CSV 导出 |
| `GET /api/admin/diagnostics?q=…` | 有 | **诊断某句话为什么被拦/命中**，给出离阈值还差多少 |
| `POST /api/knowledge/reload` | 有 | 重载知识、重建索引、清答案缓存 |

日常巡检建议：

- 每天（或每次更新资料后）：`GET /api/health` 看 `knowledgeChunks`/`storageAvailable`；`GET /api/admin/uncovered` 看有没有新的未覆盖问题。
- 每周：`GET /api/stats` 看 `noHit` 趋势与 `tokens.reasoning`（>0 说明思考模式没关，又慢又贵）；`GET /api/admin/feedback-stats` 看点踩集中在哪些问题。

## 6. 知识更新流程（现场补资料）

```bash
# 1) 写/替换 knowledge/<展区目录>/*.md（带 frontmatter：title/zone/tags；用 ## 分节）
# 2) 重载（重建关键词 + 向量索引，清空答案缓存）
curl -X POST http://127.0.0.1:8787/api/knowledge/reload -H "authorization: Bearer $ADMIN_TOKEN"
# 3) 核对
curl -s http://127.0.0.1:8787/api/knowledge/list      # 看 chunkCount 与 retrieval.mode
# 4) 抽查（中文用 Python 发，见 docs/api.md）
#    GET /api/admin/diagnostics?q=…   在域问题应 gated=false；域外问题应 gated=true 且 distanceToGate>0
# 5) 重新标定 + 评测（改语料后必须；阈值是相对量，语料一变 IDF 分数整体平移）
cd server && ../tools/mvn -B test-compile exec:java@calibrate
cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write"
python tools/smoke.py
```

阈值若需要改，**四处同步**：`.env`、`application.yml` 默认值、`HybridRetriever.DEFAULT_MIN_KEYWORD_SCORE`、CI 环境变量。

## 7. 日志与脱敏

- 应用日志：Spring Boot 控制台格式（`HH:mm:ss.SSS LEVEL [thread] logger - msg`），部署时重定向到文件或交给一体机的服务管理方式。级别在 `application.yml` 的 `logging.level`。
- 业务日志：`DATA_DIR/events.jsonl`（默认 `server/data/events.jsonl`），超过 `LOG_MAX_BYTES` 轮转为 `events.<日期>.jsonl`。
- **访客原话默认不落明文**：`LOG_MESSAGE_MODE=hash`（默认）只记录 hash + 20 字前缀，`preview` 才落 80 字预览。展厅有隐私要求时保持 `hash`。
- 问答明文（含访客提问）只进 MySQL 的 `chat_log.message_preview`（同样受 `LOG_MESSAGE_MODE` 影响）。

## 8. 备份与恢复

| 对象 | 是否必须备份 | 方式 |
| --- | --- | --- |
| `knowledge/` | **必须** | 直接打包目录（含 `_meta/zones.json`、`_meta/synonyms.tsv`） |
| MySQL `znwd` 库 | 建议 | `mysqldump -u znwd -p znwd > znwd-$(date +%F).sql` |
| `server/indexes/` | 不必 | 可重建：`POST /api/knowledge/reload`（内容变更会自动重建） |
| `server/data/events.jsonl` | 建议留档 | 直接打包；轮转文件同目录 |

恢复：还原 `knowledge/` → 导入 sql → 还原 `.env` → 启动 → `POST /api/knowledge/reload` → 跑冒烟。

## 9. 升级与回滚

```bash
# 1) 备份 knowledge/ 与数据库（见上）
# 2) 停服务，替换 server/target/hostess-server.jar 与 web/dist
# 3) 启动，确认 GET /api/health 的 version/knowledgeChunks/storageAvailable 正常
# 4) POST /api/knowledge/reload（新版本若改了分块或打分，必须重建索引）
# 5) python tools/smoke.py 全绿后再放开展厅使用
```

回滚：换回旧 jar + 旧 `web/dist`，重启即可；若新旧版本的索引格式不同，删掉 `server/indexes/` 让它按旧代码重建。数据表是增量兼容的（只增字段/表），不需要回滚数据库。

## 10. 安全要点

- **生产必须配 `ADMIN_TOKEN`**，不要出现「`HOST=0.0.0.0` + 无 token」的组合——那等于把统计、知识重载、诊断、同义词表全对外开放。
- `CORS_ORIGINS` 显式列出展厅域名/IP，不要用 `*`。
- 应用账号只用 `znwd@localhost` 的最小权限账号，别把 root 口令写进 `.env`。
- 限流 `CHAT_RATE_PER_MIN` 是防刷底线（默认 30/分钟/IP），现场若有人连续刷提问会收到 429。
- `.env`、`server/data/`、`server/indexes/`、`web/dist/` 都不进版本库（见 `docs/development.md` 提交约定）。
