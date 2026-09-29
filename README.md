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
- **一体机正式部署**：MySQL 使用 `127.0.0.1`，`knowledge/`、向量索引、日志和前端产物全部放本机；只允许 LLM、embedding、可选 TTS/ASR 出网。正式验收要求 `/api/health` 的 `ok=true`、`ready=true`、`storageAvailable=true` 且 `knowledgeChunks>0`。详见 [docs/deployment.md](docs/deployment.md)。
- 接真模型：在 `server/.env` 里设 `LLM_PROVIDER=openai_compat` + `LLM_BASE_URL/API_KEY/MODEL`（示例见该文件的注释）。
- **回答会自动朗读、也能对着麦克风提问**：播报优先用服务端 TTS（小米 MiMo，音色/语速由 `AUDIO_*` 集中配置，key 不进前端），服务端没开或调用失败时**当场退回浏览器内置合成**——展板不会哑掉。语音提问走 16kHz 单声道 WAV（前端自己采 PCM 拼容器，不引转码依赖），识别成文字后直接提问；录音时页面上是「停读」旁边的麦克风按钮，说完点一下即结束。展厅大屏上不放运营入口——运营视图用 `?admin=1` 打开，里面可以关掉朗读、看「播报来源」、重置当前会话，以及看统计/未覆盖问题/同义词表。
- 语音开关：`server/.env` 里 `AUDIO_PROVIDER=mimo` 即启用（`AUDIO_BASE_URL`/`AUDIO_API_KEY` 留空就复用 LLM 的 MiMo 网关与 key），改回 `none` 即关闭；自动播报退回浏览器合成，语音提问不可用时仍可键盘输入。**浏览器只在安全上下文（HTTPS 或 localhost/127.0.0.1）下给麦克风**：一体机用 `http://内网IP` 打开时「语音提问」按钮不出现（自动播报不受影响）。

## 项目结构

```
znwd/
├── server/                      # Spring Boot（HTTP / RAG / LLM / MySQL）
│   ├── db/init.sql              # 建库建账号（首次部署执行一次）
│   ├── eval/retrieval-cases.json  # 检索评测用例
│   ├── indexes/                 # 向量索引（不入库，可重建）
│   └── src/main/java/com/znwd/hostess/{config,embedding,knowledge,llm,audio,http,domain,repository,session,analytics,rag,web}
├── web/                         # Vue 3 + Vite：左 1/3 形象 + 下方对话
│   └── src/{App.vue,api.ts,composables,components,styles.css}
├── knowledge/                   # RAG 知识（整目录替换业务资料；_meta/zones.json 管展区）
├── tools/                       # mvn（MSYS 包装脚本）、smoke/security/db/offline 检查脚本
├── docs/                        # 工程文档（见 docs/README.md）
└── .github/workflows/ci.yml     # 后端 test+检索基线门禁+smoke、前端 build+test+本地化检查
```

## 常用 API

- `GET /api/health`（`ok`/`ready` 表示知识快照已就绪；另含 `retrieval`、`storageAvailable`、`corsOrigins`、语音与 embedding 状态）
- `GET /api/suggestions`（`?zone=pv-clean` / `wind-inspect` / `exhibit-*`；返回**字符串数组**）
- `GET /api/zones`
- `POST /api/chat` — `{ "message", "sessionId" }` → 含 `noHit`（知识库未覆盖）与 `sources`
- `POST /api/chat/stream` — SSE（`meta` → `delta`* → `done`）
- `GET|DELETE /api/sessions/:sessionId`
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
cd server && ../tools/mvn -B test                                        # 单测（157 项）
cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write --baseline=docs/eval/baseline-java.json"   # 检索评测 + 已提交基线门禁
cd server && ../tools/mvn -B test-compile exec:java@calibrate            # 阈值标定（改语料后必跑）
cd server && ../tools/mvn -B -q test-compile exec:java@ingest -Dexec.args="--src ./inbox --zone <展区id>"   # 资料入库（PDF/Word/txt）
python tools/smoke.py                                                    # 接口契约冒烟（需服务在跑；带 ADMIN_TOKEN 时 60 项，语音启用 63 项，口径见 docs/development.md §7）
python tools/acceptance.py                                               # 问答内容验收（需真模型在跑，40 项）
cd web && npm run build && npm test                                      # 前端类型检查+构建、单测
```

当前已提交基线：145 条计分用例，检索 top1 **1.0** / top3 **1.0** / 闸门漏答 **0**（关键词阈值 6.3）；CI 逐例守住 `top1Path` 与指标不退化。语义兜底阈值为 `MIN_VECTOR_SCORE=0.75`，当前等价于关闭兜底。

## 构建

```bash
cd server && ../tools/mvn -B -DskipTests package    # → server/target/hostess-server.jar
cd web && npm ci && npm run build                   # → web/dist
```

## 配置

模板见 `server/.env.example`（LLM / Embedding / 语音 / MySQL / HTTP / 检索阈值 / 日志，逐项带说明）。
读取顺序：系统环境变量 > `server/.env` > `application.yml` 默认值。内网部署时，后端出网白名单只允许 LLM、embedding、MiMo 语音三个适配器，用 `python tools/offline-check.py` 核查。

知识正文替换与检索说明：[docs/knowledge.md](docs/knowledge.md)。
部署与运维：[docs/deployment.md](docs/deployment.md)。评测与标定：[docs/eval.md](docs/eval.md)。
待做与已知取舍：[docs/optimization-backlog.md](docs/optimization-backlog.md)。
安全口径与上线检查清单：[docs/security.md](docs/security.md)。
