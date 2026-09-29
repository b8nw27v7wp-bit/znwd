# 部署与运维（展厅 / 一体机）

产物：后端 `server/target/hostess-server.jar`（Spring Boot 可执行 jar）+ 前端静态文件 `web/dist`。
数据库：MySQL 8+（开发机可不配置；**一体机正式部署要求本机 MySQL 8+，并验收 `storageAvailable=true`**）。

## 0. 一体机目标档位（当前实际部署口径）

本项目的目标部署形态是**单机闭环**，不是远程数据库架构：

- MySQL 与应用运行在同一台机器，应用使用 `DB_HOST=127.0.0.1`；不使用远程 MySQL、对象存储或远程日志服务。
- `knowledge/`、`server/indexes/`、`server/data/`、`.env` 和 jar/前端产物都在本机；断电/换机前按第 8 节备份。
- 允许出网的只有三个可插拔适配器：LLM、embedding、可选的 MiMo TTS/ASR。它们不通时必须按第 11 节的降级规则工作，不得让服务崩溃或阻塞展厅讲解。
- 生产 `.env` 不使用 `LLM_PROVIDER=mock` 冒充真实回答；`EMBED_PROVIDER=bag` 是无语义关键词档，`AUDIO_PROVIDER=none` 会关闭服务端语音并退回浏览器合成。
- 展厅浏览器与后端同机时保持 `HOST=127.0.0.1`，用 `http://127.0.0.1:<port>` 打开；这样不需要把管理接口暴露到局域网。若屏幕从另一台机器访问，才改 `HOST=0.0.0.0` 并同时配置防火墙、反代和 `ADMIN_TOKEN`。
- 麦克风只在 HTTPS 或 `localhost/127.0.0.1` 安全上下文可用；同机打开可保留语音提问，跨机 HTTP 访问时按钮会隐藏，键盘问答不受影响。

一体机上线前的最小验收顺序：启动本机 MySQL → 执行 `server/db/init.sql` → 启动 jar → 打开 `GET /api/health` → 确认 `ok=true`、`ready=true`、`storageAvailable=true`、`knowledgeChunks>0` → 跑 `tools/smoke.py`（要带与被测实例同源的 `ADMIN_TOKEN`，否则管理块与 `/api/knowledge/list` 会 401）、`tools/security.py`、`tools/db-check.py` 和 `tools/offline-check.py --runtime`。

## 1. 部署形态

```
展厅一体机（或后台电脑）
├── hostess-server.jar        监听 HOST:PORT（默认 127.0.0.1:8787）
├── web/dist/                 静态文件（任意静态服务器/Nginx，或 vite preview 自查）
├── knowledge/                知识正文（必须与 jar 同机可读，路径由 KNOWLEDGE_DIR 指定）
├── server/data/              events.jsonl 日志（DATA_DIR）
└── server/indexes/           向量索引（INDEX_DIR，可重建，丢了会自动重建）
```

- **默认只监听本机**（`HOST=127.0.0.1`）。展厅内网跨机访问要显式改 `HOST=0.0.0.0`，并限制防火墙或经反向代理暴露；管理接口默认要求 `ADMIN_TOKEN`，只有开发回环环境显式设置 `REQUIRE_ADMIN_TOKEN=false` 才免口令。
- 前端 dev/preview 由 Vite 把 `/api` 代理到 `VITE_API_TARGET`（默认 `http://127.0.0.1:8787`）；SSE 会被强制 `no-cache, no-transform`，否则看不到逐字输出。
- 展厅现场自查：`npm run build && npm run preview`（`:4173`，同样代理 `/api`），不必装 Nginx。

### 1.1 前端产物怎么接后端（两种拓扑，二选一）

**默认构建的前端是「同源」的**：`apiUrl()` 不带前缀时请求 `/api/...`，也就是打到**托管页面的那个源**。所以静态服务器必须把 `/api` 转给 jar，否则页面能打开、所有接口都 404——现场表现是「白屏/一直转圈」，而 curl 后端又是好的。

**拓扑 A（推荐）：静态服务器反代 `/api`**，前端用默认构建（不需要 `VITE_API_BASE_URL`）：

```nginx
server {
  listen 8080;
  root /opt/znwd/web/dist;
  location / { try_files $uri $uri/ /index.html; }        # SPA 回退，刷新子路径不会 404
  location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Connection "";                       # 让 SSE 用长连接
    proxy_buffering off;                                  # 必须关：否则回答会「憋完一次性吐」
    proxy_read_timeout 300s;                              # 给流式回答留足
  }
}
```

**拓扑 B：前端与后端跨源**——构建时把 API 前缀写死：`VITE_API_BASE_URL=http://127.0.0.1:8787 npm run build`（末尾不要带 `/`），并在后端配 `CORS_ORIGINS`：

- 前端从**本机回环**打开（`http://127.0.0.1:任意端口`、`http://localhost:…`）时，后端默认就放行（`CorsPolicy` 内置回环源规则），**不用配** `CORS_ORIGINS`；`vite preview` 走的就是这种。
- 前端要从**别的机器/非回环地址**打开，必须 `CORS_ORIGINS=http://<前端来源>`（逗号分隔，可用 `*` 但等于对所有来源开放，展厅内网也要慎用）；不配的表现是浏览器把所有接口请求拦在预检，后端日志里**一条都看不到**。

排障口诀：**curl 后端好、页面却什么接口都不通** → 先看 Network 里的请求 URL 打到哪个源（拓扑没配对），再看是否 CORS（跨源没配白名单），最后看 SSE 是否被代理缓冲（回答一次性出现）。

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
| `ADMIN_TOKEN` | 空 | 管理接口 Bearer 口令。默认未配置，未配置时管理接口直接 401；要使用运营功能必须设置 |
| `REQUIRE_ADMIN_TOKEN` | `true` | 默认强制管理口令；仅可信的回环开发环境可显式设为 `false`。回环按连接对端 `remoteAddr` 判断，不按 `localAddr` |
| `NODE_ENV` | 空 | `production`/`prod`/`staging` 时即使关闭上一项也强制管理口令 |
| `CORS_ORIGINS` | 空 | 逗号分隔白名单（可含 `*`）。**空 = 只放行 localhost/127.0.0.1/[::1]/0.0.0.0**，生产必须显式配；预检允许 `GET,POST,PUT,DELETE,OPTIONS` |
| `CHAT_RATE_PER_MIN` | `30` | 每 IP 每分钟问答上限 |

### 语音（TTS / ASR）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AUDIO_PROVIDER` | `none` | `none` = 关闭（前端自动退回浏览器内置播报）；`mimo` = 走小米 MiMo 的 TTS/ASR |
| `AUDIO_BASE_URL` / `AUDIO_API_KEY` | 空 | 留空即复用 `LLM_BASE_URL` / `LLM_API_KEY`（MiMo 的语音与对话同网关、同 key） |
| `AUDIO_VOICE` | `冰糖` | 预置音色：冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean/mimo_default |
| `AUDIO_STYLE` | 展厅讲解员口吻 | 音色风格指令（走 user 消息，不会被念出来） |
| `AUDIO_TTS_MODEL` / `AUDIO_ASR_MODEL` | `mimo-v2.5-tts` / `mimo-v2.5-asr` | 语音模型 |
| `AUDIO_ASR_LANGUAGE` | `zh` | `auto` / `zh` / `en` |
| `AUDIO_MAX_CHARS` | `300` | 单次合成文本上限（前端按句切片，正常远小于它） |
| `AUDIO_MAX_UPLOAD_BYTES` | `2097152` | 识别上传上限（解码后的 WAV 字节）。反代侧上限不得低于它，否则录音会被 413 拦在门外 |
| `AUDIO_TTS_CACHE_SIZE` | `64` | 合成结果缓存条数（展厅重复问题命中即省一次外部调用） |
| `AUDIO_SYNTH_RATE_PER_MIN` | `60` | 每 IP 每分钟合成上限（识别则与问答共用 `CHAT_RATE_PER_MIN`） |

两条只有到部署现场才会暴露的硬约束：

- **麦克风需要安全上下文**：浏览器只在 HTTPS 或 `localhost`／`127.0.0.1` 下给 `getUserMedia`。一体机上直接用 `http://内网IP` 打开时「语音提问」按钮不会出现（自动播报不受影响）。要么在本机以 `http://127.0.0.1:端口` 打开，要么给内网访问配一张证书。
- **请求体上限**：语音接口单次上传最大约 853KB（20 秒录音 → 640KB WAV → base64）。Nginx 默认 `client_max_body_size 1m` 勉强够，建议显式设 `2m`；应用内还有一道 2MB 硬上限（`RequestSizeLimitFilter`），配得再大也会被它先拦。

### MySQL（一体机本机库）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DB_HOST` | `127.0.0.1` | 一体机固定为本机回环；不要改成远程地址 |
| `DB_PORT` | `3306` | 本机 MySQL 端口 |
| `DB_NAME` | `znwd` | 库名 |
| `DB_USER` | `znwd` | 应用账号（**不要用 root**） |
| `DB_PASSWORD` | 空 | 与 `init.sql` 里设置的口令一致 |
| `DB_POOL_SIZE` | `8` | Hikari 连接池上限 |
| `DB_SSL_MODE` | `DISABLED` | 本机回环连接可保持关闭；若未来迁移到远程库，必须改为 `VERIFY_IDENTITY` |
| `DB_ALLOW_PUBLIC_KEY_RETRIEVAL` | `true` | 本机 MySQL 认证兼容项；不需要时应显式设为 `false` |

本机 MySQL 8+ 必须先作为系统服务启动并设为开机自启。应用允许在库暂时不可用时启动，但一体机正式验收不能接受 `storageAvailable=false`；应用会自动重探，库恢复后无需重启。

### 检索与知识库

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KNOWLEDGE_DIR` | `./knowledge` | 知识正文目录（相对仓库根或绝对路径） |
| `INDEX_DIR` | `./server/indexes` | 向量索引目录（可删，会自动重建） |
| `DATA_DIR` | `./server/data` | JSONL 日志目录 |
| `MIN_RELEVANCE_SCORE` | `6.3` | 相关性闸门阈值（标定得出，改语料后必须重标） |
| `MIN_VECTOR_SCORE` | `0.75` | 语义向量兜底阈值。当前值等价于关闭兜底：域外最高余弦 0.6252 高于待救在域用例（0 条），区间不成立；改动后须用 `calibrate --gate-check` 复核 |
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
| `EMBED_PROVIDER` | `bag` | `bag`（无语义）\| `openai_compat`（真语义；换 provider 后必须重建索引：`POST /api/knowledge/reload` 或重启） |
| `EMBED_BASE_URL` / `EMBED_API_KEY` / `EMBED_MODEL` | 空 | OpenAI 兼容 `/embeddings`。本项目现用硅基流动 `https://api.siliconflow.cn/v1` + `BAAI/bge-m3`（1024 维、免费档有限流） |
| `EMBED_DIMS` | `0` | 期望维度（bge-m3 = `1024`）；0 = 由首次响应推断 |
| `EMBED_BATCH_SIZE` | `32` | 单请求条数上限：各家不同（阿里云百炼 10、硅基流动 32），**超一条整个请求 400** |
| `EMBED_TIMEOUT_MS` | `60000` | 单次向量化请求超时 |
| `LOG_MAX_BYTES` | `5000000` | `events.jsonl` 轮转阈值 |
| `LOG_MESSAGE_MODE` | `hash` | `hash`（只落 hash + 20 字前缀）\| `preview`（落 80 字预览） |

## 4. MySQL 初始化（一体机本机）

1. 在一体机安装并启动 MySQL 8+，设为开机自启；确认只监听本机或由本机防火墙保护。
2. 复制 `server/.env.example` 为 `server/.env`，先把 `DB_HOST` 保持为 `127.0.0.1`。
3. 把 `server/db/init.sql` 里两处 `CHANGE_ME_znwd` 改成同一个自定口令。
4. 用本机管理员账号执行一次（命令行或 MySQL Workbench 打开后执行）：

```bash
mysql -u root -p < server/db/init.sql
```

5. 把同一口令写入 `server/.env` 的 `DB_PASSWORD`，启动应用。
6. 打开 `GET /api/health`，确认 `ok=true`、`ready=true`、`storageAvailable=true`、`knowledgeChunks>0`；用 `db-check.py` 复核最小权限和脱敏。

`init.sql` 只做三件事：建库 `znwd`、建本机最小权限账号 `znwd@localhost`、授权该库读写。**表结构不用手建**——应用启动时 `DatabaseStatus` 在库可达的情况下幂等执行 `schema.sql`（五张表：`session`、`session_message`、`chat_log`、`feedback`、`uncovered_question`）。

一体机正式上线判定：MySQL 服务开机自启、应用 jar 开机自启、`.env` 和 `knowledge/` 有备份；任一条件不满足都不算可交付部署。

判断服务是否可开始巡检：先看 `GET /api/health` 的 `ok=true`、`ready=true`（知识快照已发布）；再看 `storageAvailable`（一体机正式部署要求为 `true`；`false` 只表示降级为不落库）。该接口始终回 HTTP 200，探活脚本不能只看状态码。

## 5. 运维接口

| 接口 | 鉴权 | 用途 |
| --- | --- | --- |
| `GET /api/health` | 无 | 版本、`ok`/`ready` 知识就绪状态、知识块数、检索模式与阈值、embedding/语音状态、`storageAvailable`、CORS 白名单、运行时长 |
| `GET /api/health/summary` | 无 | 零敏感摘要：问答总数、未覆盖数、活跃会话、检索模式 |
| `GET /api/stats` | 有 | 累计统计、token 用量、反馈计数（落库，重启不清零） |
| `GET /api/admin/uncovered` | 有 | 未覆盖问题清单（补资料的靶子） |
| `GET /api/admin/feedback-stats?format=csv` | 有 | 反馈汇总 / CSV 导出 |
| `GET /api/admin/diagnostics?q=…` | 有 | **诊断某句话为什么被拦/命中**，给出离阈值还差多少 |
| `POST /api/knowledge/reload` | 有 | 重载知识、重建索引、清答案缓存 |

日常巡检建议：

- 每天（或每次更新资料后）：`GET /api/health` 看 `ok`/`ready`/`knowledgeChunks`/`storageAvailable`；`GET /api/admin/uncovered` 看有没有新的未覆盖问题。
- 每周：`GET /api/stats` 看 `noHit` 趋势与 `tokens.reasoning`（>0 说明思考模式没关，又慢又贵）；`GET /api/admin/feedback-stats` 看点踩集中在哪些问题。

## 6. 知识更新流程（现场补资料）

```bash
# 1) 写/替换 knowledge/<展区目录>/*.md（带 frontmatter：title/zone/tags；用 ## 分节）
# 2) 重载（重建关键词 + 向量索引，清空答案缓存）
curl -X POST http://127.0.0.1:8787/api/knowledge/reload -H "authorization: Bearer $ADMIN_TOKEN"
# 3) 核对
curl -s -H "authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/api/knowledge/list      # 看 chunkCount 与 retrieval.mode（需管理口令）
# 4) 抽查（中文用 Python 发，见 docs/api.md）
#    GET /api/admin/diagnostics?q=…   在域问题应 gated=false；域外问题应 gated=true 且 distanceToGate>0
# 5) 重新标定 + 评测（改语料后必须；阈值是相对量，语料一变 IDF 分数整体平移）
cd server && ../tools/mvn -B test-compile exec:java@calibrate
cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write --baseline=docs/eval/baseline-java.json"
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
# 3) 启动，确认 GET /api/health 的 version/ok/ready/knowledgeChunks/storageAvailable 正常
# 4) POST /api/knowledge/reload（新版本若改了分块或打分，必须重建索引）
# 5) 检索评测（不写报告，验证 top1/top3 仍为 1.0 且与基线无回归）
cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write --baseline=docs/eval/baseline-java.json"
# 6) 闸门余量核查（域外最高分不得越线，否则退出码 4）
cd server && ../tools/mvn -B test-compile exec:java@calibrate -Dexec.args="--gate-check --no-write"
# 7) python tools/smoke.py 全绿后再放开展厅使用
```

回滚：换回旧 jar + 旧 `web/dist`，重启即可；若新旧版本的索引格式不同，删掉 `server/indexes/` 让它按旧代码重建。数据表是增量兼容的（只增字段/表），不需要回滚数据库。

## 10. 安全要点

- **必须配 `ADMIN_TOKEN`**：默认 `REQUIRE_ADMIN_TOKEN=true`，未配口令时回环与非回环管理请求都一律 401（fail-closed）；只有显式关闭该开关的可信开发环境才按 `remoteAddr` 放行回环。配口令后运营视图才可用。
- MySQL 账号是最小权限（`SELECT/INSERT/UPDATE/DELETE/CREATE`，只限 `znwd` 库）：改表结构需要临时 `GRANT ALTER, DROP`。
- 库不可用时写库与定时裁剪都会**跳过**（不再白等 Hikari 的 connection-timeout，实测 3 秒 → 毫秒级），日志也不刷建连堆栈；应用每 60 秒自动重探一次，**恢复后无需重启即接着落库**，`/api/health` 的 `storageAvailable` 会跟着变回 true。
- `CORS_ORIGINS` 显式列出展厅域名/IP，不要用 `*`。
- 应用账号只用 `znwd@localhost` 的最小权限账号，别把 root 口令写进 `.env`。
- 限流 `CHAT_RATE_PER_MIN` 是防刷底线（默认 30/分钟/IP），现场若有人连续刷提问会收到 429。
- `.env`、`server/data/`、`server/indexes/`、`web/dist/` 都不进版本库（见 `docs/development.md` 提交约定）。

## 11. 单机出网与降级：仅 LLM、embedding 与可选语音服务出网

一体机不连接远程 MySQL、对象存储或远程日志服务；后端只允许三个可插拔适配器发起网络请求：LLM、embedding、MiMo 语音。模型/语音出网是允许的，但它们不可用时必须优雅降级。这条要求现在是**可执行的检查**，不是口头约定：

```bash
python tools/offline-check.py              # 产物 / 后端源码出网入口 / 依赖清单
python tools/offline-check.py --runtime    # 追加：语义路状态与检索模式是否自洽
```

| 类别 | 结论 | 依据 |
| --- | --- | --- |
| 前端产物 | 无任何联网引用（字体走系统栈、形象图本地、无 CDN/埋点） | O01–O03 扫 `web/dist` |
| 后端出网入口 | 只有 `llm/OpenAiCompatChatModel`、`embedding/OpenAiCompatEmbeddingProvider`、`audio/MimoSpeechModel` | O04 扫源码（白名单之外出现 HTTP/Socket 调用即失败） |
| 依赖 | 无云 SDK / 遥测库 | O05 扫 `pom.xml`、`package.json` |
| 知识/检索/闸门/落库 | 全在本地 | MySQL 本机；向量索引是本地 JSON 文件（`server/indexes/vectors.<provider>.json`） |

### 一体机生产配置起点

```dotenv
# 本机闭环：数据库、日志、索引、知识正文都不出机
DB_HOST=127.0.0.1
DB_NAME=znwd
DB_USER=znwd
HOST=127.0.0.1
ADMIN_TOKEN=<现场生成的长随机口令>
REQUIRE_ADMIN_TOKEN=true

# 真实回答需要 LLM 出网
LLM_PROVIDER=openai_compat
LLM_BASE_URL=<现场填写的 OpenAI 兼容地址>
LLM_API_KEY=<现场填写，不要入库>
LLM_MODEL=<现场填写>

# 可选：语义索引已在本机落盘后，查询仍按配置决定是否需要外部 embedding
EMBED_PROVIDER=openai_compat
EMBED_BASE_URL=<现场填写>
EMBED_API_KEY=<现场填写>
EMBED_MODEL=<现场填写>

# 可选：服务端语音；失败时前端退回浏览器合成
AUDIO_PROVIDER=mimo
```

`server/.env` 不进版本库；上述占位符必须在现场替换。若现场网络策略不允许模型出网，改用本机 OpenAI 兼容服务地址，或接受 `LLM_PROVIDER=mock` 仅用于演示，不能把它当作生产回答。

出网口与降级规则：

- **LLM**：`LLM_PROVIDER=mock` 时不外呼；真实模型不可达时命中问题无法生成回答，页面给友好提示。域外问题被闸门拦截时不调用模型。
- **embedding**：`openai_compat` 指向云端 `/embeddings`。向量索引已落盘且指纹一致时，启动和关键词命中的查询可不依赖联网；关键词未过闸门且启用语义兜底时才需要外部向量化，服务不可用时退回仅关键词，并在 `/api/health` 报 `embeddingReady=false` 与降级原因。
- **语音**：`AUDIO_PROVIDER=mimo` 才允许 `MimoSpeechModel` 出网；未启用时两个接口返回 503，上游失败时返回 502。TTS 失败会当场退回浏览器内置合成；ASR 不可用时访客仍可键盘提问。`none` 是内网部署的默认值。

**没网时会发生什么**（按组件逐个说清，避免现场才发现）：

| 场景 | 表现 |
| --- | --- |
| 启动、加载知识、检索、闸门判定 | 正常（都是本地计算；向量索引从本地文件加载；`/api/health` 最终 `ready=true`） |
| 域外/未覆盖问题 | 正常给固定拒答（闸门拦截不调用大模型） |
| 命中知识的问题 | 需要调大模型；没网则回答失败，页面给友好提示，技术原因进运营视图 |
| embedding 服务不可用 | 服务照常起、照常答（检索退回仅关键词）；下一次查询成功自愈 |
| 语料改动后需要重建向量索引 | 这时才需要 embedding 服务可达；不可达则退回仅关键词并在 health 说明原因，不会让服务起不来 |
| 服务端语音关闭或不可达 | TTS 退回浏览器合成；语音提问不可用，键盘问答不受影响 |
| 演示/验收（无网、无模型） | `LLM_PROVIDER=mock`：问答链路可跑，回答是带「Mock 演示回复」的固定摘要 |
| 想离线也有真回答 | 在机器上放本地大模型，`LLM_BASE_URL` 指向它（OpenAI 兼容即可，无需改代码）；embedding 同理可指向本机 Ollama 的 `/v1` |

自检套件本身也都在本地跑：`smoke.py`（接口契约）、`security.py`（边界与安全）、`db-check.py`（库层）、
`offline-check.py`（本地化不变量），都不需要外网，可直接拷到一体机上执行。
