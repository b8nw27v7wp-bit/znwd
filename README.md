# AI 虚拟讲解问答（产品展厅）

浏览器大屏：**整页仅占左约 1/4（CSS `--panel-width: 25%`）**——上方虚拟形象，**下方对话框**；右侧约 3/4 留白（可并排放展览视频）。
基于本地企业知识 **Hybrid RAG** 与可插拔 **LLM** 生成回答。

当前知识业务：**光伏清洁机器人**、**光伏医生智慧运维**、**项目与团队**（语料来自三份申报/项目概述材料）。

技术栈：后端 **Spring Boot 3.5.16**（Java 21 目标）+ MyBatis + **MySQL**；前端 **Vue 3 + Vite 6 + TypeScript**（纯手写 CSS，不引 UI 框架）。
（2026-09 由 Node/Fastify + React 原地重写而来，旧代码只在 git 历史里。）

## 目录

- [部署与运行](#部署与运行) — 环境、配置、建库、构建、起服务、托管前端、验收、排障
- [项目结构](#项目结构) · [常用 API](#常用-api) · [校验命令](#校验命令) · [配置](#配置)

## 部署与运行

> 生产部署的完整说明（两种前后端拓扑、nginx 片段、备份恢复、升级回滚、降级规则）见 [docs/deployment.md](docs/deployment.md)；本节是可照抄跑通的最短路径。

### 0. 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| JDK | **21+** | `maven.compiler.release=21`；本机用 JDK 25 跑通 |
| Maven | 3.9.x | git-bash/MSYS 下用仓库自带的 `tools/mvn`（见下）；PowerShell/cmd 可直接用系统 `mvn` |
| Node | 20+（本机 22/24） | 前端构建与单测 |
| MySQL | 8+ / 9.x，**可选** | 不装也能讲解，只是不落库（`/api/health` 报 `storageAvailable=false`）；一体机正式部署要求本机 MySQL 并验收 `storageAvailable=true` |

git-bash/MSYS 下**不要直接敲 `mvn`**：官方脚本走 mingw 分支、不把 `/d/Maven/...` 转成 Windows 路径，java 会报「找不到主类 Launcher」。用仓库自带的 `../tools/mvn` 绕开（换机时改它顶部的 `MVN_HOME_WIN` / `JAVA_HOME_WIN`，或用同名环境变量覆盖）。PowerShell/cmd 无此问题，`mvn` 可直接用。

### 1. 配置

```bash
cp server/.env.example server/.env        # 模板带逐项注释；.env 不入库、不提交密钥
```

默认模板是**安全演示档**（`LLM_PROVIDER=mock` / `EMBED_PROVIDER=bag` / `AUDIO_PROVIDER=none`，不落库），开箱即可起。接真实能力时按需改：

- 真实回答：`LLM_PROVIDER=openai_compat` + `LLM_BASE_URL/API_KEY/MODEL`（小米 MiMo 示例见 `.env.example`；`LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}` 必填）。
- 语义向量路：`EMBED_PROVIDER=openai_compat` + `EMBED_*`（本项目用硅基流动 `BAAI/bge-m3`，1024 维），换 provider 后重建索引（`POST /api/knowledge/reload` 或重启）。
- 服务端语音：`AUDIO_PROVIDER=mimo`（`AUDIO_BASE_URL/API_KEY` 留空即复用 LLM 的 MiMo 网关与 key）。
- 管理口令：配 `ADMIN_TOKEN`（长随机串）；未配时管理接口默认一律 401（`REQUIRE_ADMIN_TOKEN` 默认 `true`）。

读取顺序：**系统环境变量 > `server/.env` > `application.yml` 默认值**；`.env` 里空值视为未配置。全部键名以 `server/src/main/resources/application.yml` 为准，模板见 `server/.env.example`。

### 2. 初始化 MySQL（可选；一体机正式部署必须）

```bash
# 1) 把 server/db/init.sql 里两处 CHANGE_ME_znwd 改成同自定口令
# 2) 用本机管理员账号执行一次（建库 znwd + 最小权限账号 znwd@localhost）
mysql -u root -p < server/db/init.sql
# 3) 把同一口令写进 server/.env 的 DB_PASSWORD
```

表结构不用手建：应用在库可达时幂等执行 `schema.sql`（`session`/`session_message`/`chat_log`/`feedback`/`uncovered_question`）。一体机固定 `DB_HOST=127.0.0.1`，不配远程库。

### 3. 本地开发运行

```bash
# 后端 :8787（git-bash 用 ../tools/mvn；PowerShell/cmd 用 mvn）
cd server && ../tools/mvn spring-boot:run

# 前端 :5173，Vite 把 /api 代理到 8787
cd web && npm install && npm run dev
```

打开 `http://localhost:5173`，在对话区提问（Enter 发送）。运营视图：`http://localhost:5173/?admin=1`（需 `ADMIN_TOKEN`）。

### 4. 生产构建与运行

```bash
# 构建后端可执行 jar → server/target/hostess-server.jar
cd server && ../tools/mvn -B -DskipTests package

# 构建前端静态产物 → web/dist
cd web && npm ci && npm run build
```

```bash
# 起后端（默认监听 127.0.0.1:8787；从 server 目录起，knowledge/ 与 data/ 会自动定位到仓库根）
cd server && java -jar target/hostess-server.jar
```

> **Windows 注意**：`-DskipTests package` 会 `repackage` 覆盖 `hostess-server.jar`，而正在运行的实例锁着这个文件，会报 `Unable to rename ... -> .original`。**先停掉旧实例再构建**。

前端产物怎么接后端（两种拓扑，二选一）：

- **拓扑 A（推荐）**：静态服务器反代 `/api` 到 `127.0.0.1:8787`，前端用默认构建即可。nginx 必须关缓冲，否则 SSE 回答会「憋完一次性吐」：

  ```nginx
  location / { try_files $uri $uri/ /index.html; }   # SPA 回退
  location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;                              # SSE 逐字输出的关键
    proxy_read_timeout 300s;
  }
  ```

- **拓扑 B**：前端与后端跨源——构建期写死前缀 `VITE_API_BASE_URL=http://<后端>:8787 npm run build`（末尾不带 `/`），并在后端配 `CORS_ORIGINS=http://<前端来源>`。
- **现场自查**（不装 nginx）：`cd web && npm run preview`（`:4173`，同样代理 `/api`）。

展厅同机时保持 `HOST=127.0.0.1`、用 `http://127.0.0.1:<port>` 打开，管理接口就不必暴露到局域网；麦克风也只在 HTTPS 或 `localhost/127.0.0.1` 安全上下文可用（跨机 `http://内网IP` 打开时「语音提问」按钮不出现，键盘问答与自动播报不受影响）。

### 5. 启动验收与日常运维

```bash
# 等就绪：接口始终回 HTTP 200，必须读 JSON 字段，别只看状态码
curl -s http://127.0.0.1:8787/api/health
# 正式验收要求：ok=true、ready=true、storageAvailable=true、knowledgeChunks>0
```

- **重载知识 / 重建索引 / 清答案缓存**：`POST /api/knowledge/reload`（带 `Authorization: Bearer $ADMIN_TOKEN`）。
- **诊断某句话为什么被拦/命中**：`GET /api/admin/diagnostics?q=…`（中文 query 用 Python 发，避免 GBK 控制台编坏，见 `docs/api.md`）。
- **回滚**：换回旧 `jar` + 旧 `web/dist` 重启即可；数据表是增量兼容的，不需要回滚数据库。

## 项目结构

```
znwd/
├── server/                      # Spring Boot（HTTP / RAG / LLM / MySQL）
│   ├── db/init.sql              # 建库建账号（首次部署执行一次）
│   ├── eval/retrieval-cases.json  # 检索评测用例
│   ├── indexes/                 # 向量索引（不入库，可重建）
│   └── src/main/java/com/znwd/hostess/{config,embedding,knowledge,llm,audio,http,domain,repository,session,analytics,rag,web}
├── web/                         # Vue 3 + Vite：左约 1/4（CSS `--panel-width: 25%`）形象 + 下方对话
│   └── src/{App.vue,api.ts,composables,components,styles.css}
├── knowledge/                   # RAG 知识（整目录替换业务资料；_meta/zones.json 管展区）
├── tools/                       # mvn（MSYS 包装脚本）、smoke/security/db/offline 检查脚本
├── docs/                        # 工程文档（见 docs/README.md）
└── .github/workflows/ci.yml     # 后端 test+检索基线门禁+smoke、前端 build+test+本地化检查
```

## 常用 API

- `GET /api/health`（`ok`/`ready` 表示知识快照已就绪；另含 `retrieval`、`storageAvailable`、`corsOrigins`、语音与 embedding 状态）
- `GET /api/suggestions`（`?zone=pv-clean` / `pv-doctor` / `project` / `exhibit-*`；返回**字符串数组**。`wind-inspect` 是已退役的风场展区，仅作历史示例）
- `GET /api/zones`
- `POST /api/chat` — `{ "message", "sessionId" }` → 含 `noHit`（知识库未覆盖）与 `sources`
- `POST /api/chat/stream` — SSE（`meta` → `delta`* → `done`）
- `GET|DELETE /api/sessions/:sessionId`（需 `X-Session-Token`，问答时下发）
- `POST /api/feedback`（未带 `question` 时自动取会话最后一条提问）
- `GET /api/knowledge/list`（含 `retrieval` 与同义词表摘要；需管理口令）
- `POST /api/knowledge/reload`（重建关键词 + 向量索引，清答案缓存）
- `GET /api/admin/diagnostics?q=…` — 检索诊断：为什么被拦/为什么命中、离阈值还差多少
- `GET|PUT /api/admin/synonyms` — 同义词表在线维护（改完立即生效，可选落盘）
- `GET /api/stats`、`GET /api/admin/feedback-stats`（`?format=csv`）、`GET /api/admin/uncovered`
- `GET /api/openapi.json`

管理类接口的鉴权默认 fail-closed：配置 `ADMIN_TOKEN` 后必须带 `Authorization: Bearer <token>`（常量时间比对）；未配置时默认一律 401，只有显式设置 `REQUIRE_ADMIN_TOKEN=false` 的回环开发环境才放行。回环按连接对端 `remoteAddr` 判断，不会被同机反向代理的 `localAddr` 绕过；CORS 预检已放行 `PUT`，供同义词表在线替换。

## 校验命令

```bash
cd server && ../tools/mvn -B test                                        # 单测（167 项）
cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write --baseline=docs/eval/baseline-java.json"   # 检索评测 + 已提交基线门禁
cd server && ../tools/mvn -B test-compile exec:java@calibrate            # 阈值标定（改语料后必跑）
cd server && ../tools/mvn -B -q test-compile exec:java@ingest -Dexec.args="--src ./inbox --zone <展区id>"   # 资料入库（PDF/Word/txt）
python tools/smoke.py                                                    # 接口契约冒烟（需服务在跑；带 ADMIN_TOKEN 满跑 100 项）
python tools/security.py                                                 # 边界与安全（主实例 91/0/7；另起第二/误配置实例跑满）
python tools/db-check.py                                                 # 库层脱敏与最小权限（需 mysql 客户端）
python tools/offline-check.py --runtime                                  # 本地化不变量（除 LLM/embedding/语音外一律本地）
python tools/acceptance.py                                               # 问答内容验收（需真模型在跑，40 项）
cd web && npm run build && npm test                                      # 前端类型检查+构建、单测（144 项）
```

当前已提交基线：145 条计分用例，检索 top1 **1.0** / top3 **1.0** / 闸门漏答 **0**（关键词阈值 6.3）；按闸门排序分口径区间成立（域外最高 6.170 < 6.3 < 在域最低 6.438，余量 0.130），CI 逐例守住 `top1Path` 与指标不退化。语义兜底阈值 `MIN_VECTOR_SCORE=0.75`，当前等价于关闭兜底。

## 配置

模板见 `server/.env.example`（LLM / Embedding / 语音 / MySQL / HTTP / 检索阈值 / Prompt / 日志，逐项带说明）。
读取顺序：系统环境变量 > `server/.env` > `application.yml` 默认值。内网部署时，后端出网白名单只允许 LLM、embedding、MiMo 语音三个适配器，用 `python tools/offline-check.py` 核查。

- 知识正文替换与检索说明：[docs/knowledge.md](docs/knowledge.md)
- 部署与运维（拓扑、备份恢复、升级回滚、降级）：[docs/deployment.md](docs/deployment.md)
- 评测与标定：[docs/eval.md](docs/eval.md)
- 待做与已知取舍：[docs/optimization-backlog.md](docs/optimization-backlog.md)
- 安全口径与上线检查清单：[docs/security.md](docs/security.md)
