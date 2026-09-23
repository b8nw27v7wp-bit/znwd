# AI 虚拟讲解问答（产品展厅）

浏览器大屏：**整页仅占左约 1/3**——上方虚拟形象，**下方对话框**；右侧约 2/3 留白（可并排放展览视频）。
基于本地企业知识 **Hybrid RAG** 与可插拔 **LLM** 生成回答。

当前知识业务：**光伏清洁机器人**、**光伏医生智慧运维**、**项目与团队**（语料来自三份申报/项目概述材料）。

技术栈：后端 **Spring Boot 3.5.16**（Java 21 目标）+ MyBatis + **MySQL**；前端 **Vue 3 + Vite 6 + TypeScript**（纯手写 CSS，不引 UI 框架）。
（2026-09 由 Node/Fastify + React 原地重写而来，旧代码只在 git 历史里。）

## 快速开始

```bash
# 配置（可选：不配也能跑，LLM 走 mock、不落库）
cp server/.env.example server/.env

# 起后端（:8787）—— 用仓库自带的 maven 包装脚本，别用系统 mvn（见 docs/development.md）
cd server && ../tools/mvn spring-boot:run

# 起前端（:5173，/api 自动代理到 8787）
cd web && npm install && npm run dev
```

打开 `http://localhost:5173`，在对话区提问（Enter 发送）。

- **没有 MySQL 也能起**：会话/统计不落库，`/api/health` 报 `storageAvailable=false`。展厅页面上不提示（大屏不放技术信息），要看落库状态就打开运营视图 `?admin=1`，「本机设置」里有一行数据留存。
  要真落库：把 `server/db/init.sql` 里两处 `CHANGE_ME_znwd` 改成自定口令执行一次，再把同一口令写进 `server/.env` 的 `DB_PASSWORD`。
- 接真模型：在 `server/.env` 里设 `LLM_PROVIDER=openai_compat` + `LLM_BASE_URL/API_KEY/MODEL`（示例见该文件的注释）。
- **回答会自动朗读**（浏览器内置语音合成，零依赖、离线可用）：默认开，选择记在浏览器里；朗读中页面上会出现「停读」。展厅大屏上不放运营入口——运营视图用 `?admin=1` 打开，里面可以关掉朗读、重置当前会话，以及看统计/未覆盖问题/同义词表。

## 项目结构

```
znwd/
├── server/                      # Spring Boot（HTTP / RAG / LLM / MySQL）
│   ├── db/init.sql              # 建库建账号（首次部署执行一次）
│   ├── eval/retrieval-cases.json  # 检索评测用例
│   ├── indexes/                 # 向量索引（不入库，可重建）
│   └── src/main/java/com/znwd/hostess/{config,embedding,knowledge,llm,http,domain,repository,session,analytics,rag,web}
├── web/                         # Vue 3 + Vite：左 1/3 形象 + 下方对话
│   └── src/{App.vue,api.ts,composables,components,styles.css}
├── knowledge/                   # RAG 知识（整目录替换业务资料；_meta/zones.json 管展区）
├── tools/                       # mvn（MSYS 包装脚本）、smoke.py（接口契约冒烟）
├── docs/                        # 工程文档（见 docs/README.md）
└── .github/workflows/ci.yml     # 后端 test+eval+smoke、前端 build+test
```

## 常用 API

- `GET /api/health`（含 `retrieval.mode`/`semantic`/`thresholds`、`storageAvailable`、`corsOrigins`）
- `GET /api/suggestions`（`?zone=pv-clean` / `wind-inspect` / `exhibit-*`；返回**字符串数组**）
- `GET /api/zones`
- `POST /api/chat` — `{ "message", "sessionId" }` → 含 `noHit`（知识库未覆盖）与 `sources`
- `POST /api/chat/stream` — SSE（`meta` → `delta`* → `done`）
- `GET|DELETE /api/sessions/:sessionId`
- `POST /api/feedback`（未带 `question` 时自动取会话最后一条提问）
- `GET /api/knowledge/list`（含 `retrieval` 与同义词表摘要）
- `POST /api/knowledge/reload`（重建关键词 + 向量索引，清答案缓存）
- `GET /api/admin/diagnostics?q=…` — 检索诊断：为什么被拦/为什么命中、离阈值还差多少
- `GET|PUT /api/admin/synonyms` — 同义词表在线维护（改完立即生效，可选落盘）
- `GET /api/stats`、`GET /api/admin/feedback-stats`（`?format=csv`）、`GET /api/admin/uncovered`
- `GET /api/openapi.json`

管理类接口的鉴权规则：配了 `ADMIN_TOKEN` 就必须带 `Authorization: Bearer <token>`（常量时间比对）；没配时开发环境放行，生产（`NODE_ENV=production|prod|staging` 或 `REQUIRE_ADMIN_TOKEN=true`）直接 401，不会静默开放。

## 校验命令

```bash
cd server && ../tools/mvn -B test                                        # 单测（83 项）
cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write"   # 检索评测
cd server && ../tools/mvn -B test-compile exec:java@calibrate            # 阈值标定（改语料后必跑）
cd server && ../tools/mvn -B -q test-compile exec:java@ingest -Dexec.args="--src ./inbox --zone <展区id>"   # 资料入库（PDF/Word/txt）
python tools/smoke.py                                                    # 接口契约冒烟（需服务在跑，56 项）
python tools/acceptance.py                                               # 问答内容验收（需真模型在跑，40 项）
cd web && npm run build && npm test                                      # 前端类型检查+构建、单测
```

当前基线：检索 top1 **0.9333** / top3 **0.9667** / 闸门漏答 **0**（阈值 8.1）；标定区间 7.272~8.856 → 建议 8.1。

## 构建

```bash
cd server && ../tools/mvn -B -DskipTests package    # → server/target/hostess-server.jar
cd web && npm ci && npm run build                   # → web/dist
```

## 配置

模板见 `server/.env.example`（LLM / Embedding / MySQL / HTTP / 检索阈值 / 日志，逐项带说明）。
读取顺序：系统环境变量 > `server/.env` > `application.yml` 默认值。

知识正文替换与检索说明：[docs/knowledge.md](docs/knowledge.md)。
部署与运维：[docs/deployment.md](docs/deployment.md)。评测与标定：[docs/eval.md](docs/eval.md)。
待做与已知取舍：[docs/optimization-backlog.md](docs/optimization-backlog.md)。
安全口径与上线检查清单：[docs/security.md](docs/security.md)。
