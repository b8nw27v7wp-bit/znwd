# 展厅智能体（znwd）

> 展厅大屏上的 AI 讲解员：访客对着屏幕上的虚拟形象提问，它按企业知识库回答、逐字上屏，并自动语音播报。

现场无人值守运行。浏览器整页只占左侧约 1/4（`--panel-width: 25%`）——上方虚拟形象、下方对话框，右侧 3/4 留白可与展览视频并排。回答来自**本地企业知识 + Hybrid RAG + 可插拔 LLM**，不是通用模型的即兴发挥。

当前知识业务：光伏清洁机器人、光伏医生智慧运维、项目与团队、光伏运维行业知识——共 **4 个展区、242 块知识、21 篇文档**。

技术栈：后端 Spring Boot 3.5.16（Java 21）+ MyBatis + MySQL；前端 Vue 3 + Vite 6 + TypeScript（纯手写 CSS，不引 UI 框架）。2026-09 由 Node/Fastify + React 原地重写而来，旧代码只留在 git 历史里。

## 它能做什么

### 访客侧：问什么答什么，答不出来就说不知道

- **流式问答**：`POST /api/chat/stream`，SSE 帧序 `meta → delta* → done`，15 秒心跳，回答逐字上屏
- **语音提问 + 自动播报**：麦克风录音（16kHz WAV，前端自采自封装）→ ASR 转文字提问；回答由服务端 TTS 播报（小米 MiMo，失败当场退回浏览器合成）
- 语音模式可切（运营面板 `?admin=1`）：**缺省点按**（点一下说话，停顿约 1 秒自动识别提交，识别调用最少）或**全双工**（麦克风常开、说话即提问、可插话打断，调用更频繁）；欢迎态另有「开始实时对话」大按钮
- 麦克风被拒 / 没听到声音 / 识别失败时，在输入区下方给一句行动指引，技术原因只进运营视图
- **多轮上下文**：最近 6 轮、TTL 10 分钟、最多 200 会话；指代与省略句自动改写补全
- **展区联动**：展区可由 URL `?zone=<zoneId|mediaId>`、`window.znwdSetZone(id)` 或 `znwd:zone` 事件切换，旁侧展项/多屏联动推荐问题；选择落 localStorage 并同步 URL

### 检索侧：宁可不答，也不编

- **Hybrid RAG**：中文 bigram + IDF 关键词路为主；语义向量（`BAAI/bge-m3`，1024 维，可选）只做诊断与「关键词不过闸门时的余弦兜底」，不参与普通排序——不让语义把关键词压过去
- **相关性闸门**：关键词排序分低于 `MIN_RELEVANCE_SCORE`（默认 6.5）且余弦不达标时，直接回固定拒答（`noHit`，**不调模型、0 token**）
- 阈值不是拍的：161 条计分用例标定，域外最高分 6.371 < 6.5 < 在域最低 6.605（余量 0.129 / 0.105）
- 当前基线：检索 top1 **0.99**（160/161）、top3 **1.0**、闸门漏答 **0**；CI 逐例守住 `top1Path` 与指标不退化

### 运营侧：现场能自己维护

- 运营视图 `?admin=1`：统计、未覆盖问题、反馈 CSV 导出、知识清单、一键 reload、同义词热更新、检索诊断（为什么被拦/命中、离阈值差多少）
- **话术外置**：system prompt 与拒答文案可放外部文件（`PROMPT_*`），现场改措辞不用重新编译
- **同义词在线维护**：`GET|PUT /api/admin/synonyms`，改完立即生效、可选落盘
- **知识入库**：`exec:java@ingest` 吃 PDF / Word / txt，按展区入库；改语料后重跑标定与评测

### 交付侧：一体机只装两样东西

目标机只需要 **JDK 21+ 与 MySQL**。前端产物由 jar 同源托管（`WEB_DIST_DIR`，默认 `./web/dist`），不需要 nginx、不涉及 CORS、不需要 Node。附 Windows 启停/自启/打包脚本。

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 后端 | Spring Boot 3.5.16（Java 21 目标） | `maven.compiler.release=21`，本机用 JDK 25 跑通 |
| 持久层 | MyBatis + MySQL 8/9 | 会话、问答日志、反馈、未覆盖问题；库不可达时 `storageAvailable=false` 仍可讲解 |
| 检索 | 自研 Hybrid RAG | 中文 bigram + IDF 关键词路（倒排 + 打分）+ 可选 bge-m3 余弦兜底 + 相关性闸门 |
| 前端 | Vue 3 + Vite 6 + TypeScript | 纯手写 CSS，无 UI 框架；SSE 消费与语音采集自实现 |
| 流式 | SSE | `meta → delta* → done`，15s 心跳，nginx 需关 `proxy_buffering` |
| 语音 | ASR + TTS（小米 MiMo） | 服务端合成，失败退回浏览器 `speechSynthesis` |
| 安全 | 管理面 fail-closed + 令牌归属 + 安全响应头 | `ADMIN_TOKEN` 常量时间比对；`X-Session-Token` 校验会话归属；`nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy` |
| 可观测 | `/api/health`、`/api/stats`、`/actuator/prometheus` | 健康检查必须读 JSON 字段，不能只看状态码 |
| 出网控制 | 三个适配器白名单 | 只有 LLM / embedding / 语音可出网，其余全在本机（`tools/offline-check.py` 可核） |
| 测试 | JUnit + Vitest + 验收脚本 | 后端 242 项、前端 303 项，另有冒烟/安全/库层/离线/验收/压测脚本 |

## 快速开始

```bash
# 1) 配置（可选：不配也能起，走 mock/bag/none、不落库）
cp server/.env.example server/.env

# 2) 起后端 :8787（git-bash 用 ../tools/mvn；PowerShell/cmd 用 mvn）
cd server && ../tools/mvn spring-boot:run

# 3) 起前端 :5173，Vite 把 /api 代理到 8787
cd web && npm install && npm run dev
```

打开 `http://localhost:5173` 提问（Enter 发送）；运营视图 `http://localhost:5173/?admin=1`（需 `ADMIN_TOKEN`）。`.env` 配了真实 provider 就走真模型；只写 `LLM_PROVIDER=mock` 则回答是带「Mock 演示回复」的固定摘要。

### 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| JDK | 21+ | **运行目标机只需这一项（+ MySQL）** |
| Maven | 3.9.x | 仅构建/评测用；git-bash/MSYS 下用仓库自带 `tools/mvn` |
| Node | 20+ | 仅构建/单测用（交付机不需要），产出 `web/dist` |
| MySQL | 8+ / 9.x，可选 | 不装也能讲解；一体机正式部署要求本机 MySQL 并验收 `storageAvailable=true` |
| Python | 3.8+，可选 | 只给 `tools/` 验收脚本用；Windows 上命令是 `py -3` |

git-bash/MSYS 下**不要直接敲 `mvn`**：官方脚本走 mingw 分支、不把 `/d/Maven/...` 转成 Windows 路径，java 会报「找不到主类 Launcher」。用仓库自带的 `../tools/mvn` 绕开（换机时改它顶部的 `MVN_HOME_WIN` / `JAVA_HOME_WIN`，或用同名环境变量覆盖）。PowerShell/cmd 无此问题。

## 部署

### 形态 A（推荐）：Windows 一体机整机，jar 直接托管前端

演示屏与后端在同一台 Windows 上时用这个形态：目标机只需要 JDK 21+ 与 MySQL，前端产物由 jar 同源托管。

**构建机（有 Node 的机器）**：

```bash
cd server && ../tools/mvn -B -DskipTests package     # → server/target/hostess-server.jar
cd web && npm ci && npm run build                    # → web/dist
tools\windows\pack.ps1                               # 打包 jar + web/dist + .env.example + knowledge/ + 脚本
```

**目标机（一体机）**：

```text
1) 安装 JDK 21+（java 在 PATH，或设 JAVA_HOME）与 MySQL 8+（设为 Windows 服务自启）
2) 解压交付包；把 server\db\init.sql 里两处 CHANGE_ME_znwd 改成自定口令并执行一次
3) 复制 server\.env.example 为 server\.env，至少填：
     DB_PASSWORD   与第 2 步一致
     ADMIN_TOKEN   长随机串（管理接口必需）
     LLM_*         真实模型（provider/base url/api key/model）
     EMBED_*       可选，语义向量（bge-m3）
     AUDIO_*       可选，服务端语音（AUDIO_PROVIDER=mimo）
4) 启动与自启：
     tools\windows\start-znwd.cmd                     前台拉起（日志 server\run.out.log）
     tools\windows\status-znwd.cmd                    看端口/java 进程/health
     tools\windows\stop-znwd.cmd                      停止
     powershell -ExecutionPolicy Bypass -File tools\windows\install-autostart.ps1             登录自启（默认）
     powershell -ExecutionPolicy Bypass -File tools\windows\install-autostart.ps1 -AtStartup  开机自启（需管理员）
5) 浏览器打开 http://127.0.0.1:8787/  （整页即应用；?admin=1 进运营视图）
```

> **交付包不含 `.env`**（只带 `.env.example`，避免把 LLM key / DB 口令 / `ADMIN_TOKEN` 打进分发 zip）。漏配时应用会静默退回 `mock/bag/none`（页面正常但答案是假摘要），启动日志会打印生效的 `chunks/embed/llm/阈值/adminRequired`，先对一眼再验收。
> 展厅同机保持 `HOST=127.0.0.1` 即可；麦克风只在 HTTPS 或 `localhost/127.0.0.1` 安全上下文可用（跨机 `http://内网IP` 打开时「语音提问」按钮不出现，键盘问答与自动播报不受影响）。

**Windows 构建注意**：`-DskipTests package` 会覆盖 `hostess-server.jar`，而运行中的实例锁着它，会报 `Unable to rename ... -> .original`——**先 `stop-znwd.cmd` 再构建**。

### 形态 B：前后端分离 / 跨机访问

- **反代（推荐）**：静态服务器把 `/api` 反代到 `127.0.0.1:8787`，前端用默认构建（同源）。nginx 必须关缓冲，否则 SSE 会「憋完一次性吐」：

  ```nginx
  location / { try_files $uri $uri/ /index.html; }   # SPA 回退
  location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;                              # SSE 逐字输出关键
    proxy_read_timeout 300s;
  }
  ```

- **跨源**：构建期写死前缀 `VITE_API_BASE_URL=http://<后端>:8787 npm run build`（末尾不带 `/`），后端配 `CORS_ORIGINS=http://<前端来源>`，并把 `HOST` 改为 `0.0.0.0`（同时配防火墙/反代）
- **现场自查**（不装 nginx）：`cd web && npm run preview`（`:4173`，同样代理 `/api`）

### 初始化 MySQL（可选；一体机正式部署必须）

```bash
# 1) 把 server/db/init.sql 里两处 CHANGE_ME_znwd 改成自定口令
# 2) 用管理员账号执行一次：建库 znwd + 最小权限账号 znwd@localhost
mysql -u root -p < server/db/init.sql
# 3) 把同一口令写进 server/.env 的 DB_PASSWORD
```

表结构不用手建：库可达时应用幂等执行 `schema.sql`（`session` / `session_message` / `chat_log` / `feedback` / `uncovered_question`）。一体机固定 `DB_HOST=127.0.0.1`，不配远程库。

## 配置

模板见 `server/.env.example`（逐项带注释）。读取顺序：**系统环境变量 > `server/.env` > `application.yml` 默认值**；`.env` 空值视为未配置。

| 组 | 关键键 | 说明 |
| --- | --- | --- |
| 模型 | `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | `mock` 或 `openai_compat`；MiMo 需 `LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}` |
| 向量 | `EMBED_PROVIDER` / `EMBED_*` / `EMBED_BATCH_SIZE` | `bag`（无语义兜底）或 `openai_compat`（bge-m3，1024 维）；换 provider 后重建索引 |
| 语音 | `AUDIO_PROVIDER` / `AUDIO_*` | `none` 或 `mimo`；base URL/key 留空即复用 LLM 的 MiMo 网关与 key |
| 数据库 | `DB_HOST` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | 一体机固定 `127.0.0.1`、非 root 的 `znwd` 账号 |
| HTTP | `HOST` / `PORT` / `ADMIN_TOKEN` / `REQUIRE_ADMIN_TOKEN` / `CORS_ORIGINS` / `TRUST_FORWARDED_FOR` | 默认 `127.0.0.1:8787`；管理鉴权默认 fail-closed |
| 前端托管 | `WEB_DIST_DIR` | 默认 `./web/dist`；目录里有 `index.html` 时 jar 托管前端（同源），不存在则自动关闭（开发用 Vite） |
| 检索 | `MIN_RELEVANCE_SCORE` / `MIN_VECTOR_SCORE` / `ANSWER_CACHE_SIZE` / `UNCOVERED_LOG_SIZE` | 阈值 6.5 / 0.75；改语料或同义词后必须重标 |
| 话术 | `PROMPT_SYSTEM_PATH` / `PROMPT_NO_HIT_HINT_PATH` / `PROMPT_NO_HIT_REPLY_PATH` | 指向外部 UTF-8 文件覆盖内置话术；随 `reload` 生效，读失败回退内置 |
| 日志 | `LOG_MAX_BYTES` / `LOG_MESSAGE_MODE` | `events.jsonl` 轮转与脱敏（默认 `hash`，只落 hash + 20 字前缀） |

限流默认：问答 30 次/分/IP（`CHAT_RATE_PER_MIN`）、反馈 10、合成 60、识别 120（与问答分开计）。

## 常用 API

- `GET /api/health`（`ok` / `ready` 知识就绪 / `retrieval` 统计 / `storageAvailable` / 语音与 embedding 状态）
- `GET /api/suggestions`（`?zone=pv-clean` / `pv-doctor` / `project` / `exhibit-*`；返回字符串数组）
- `GET /api/zones`
- `POST /api/chat` — `{ "message", "sessionId" }` → 含 `noHit`、`sources`、`sessionToken`
- `POST /api/chat/stream` — SSE（`meta` → `delta`* → `done`；`sessionToken` 在 `done` 帧）
- `GET|DELETE /api/sessions/:sessionId`（需 `X-Session-Token`，问答时下发）
- `POST /api/feedback`（未带 `question` 时自动取会话最后一条提问）
- `POST /api/speech/synthesize`（文本→WAV）、`POST /api/speech/recognize`（WAV→文本）
- `GET /api/knowledge/list`、`POST /api/knowledge/reload`、`GET /api/admin/diagnostics?q=…`、`GET|PUT /api/admin/synonyms`（需管理口令）
- `GET /api/stats`、`GET /api/admin/feedback-stats`（`?format=csv`）、`GET /api/admin/uncovered`
- `GET /api/openapi.json`、`GET /api/health/summary`

管理类接口默认 fail-closed：配了 `ADMIN_TOKEN` 就必须带 `Authorization: Bearer <token>`，未配时一律 401，只有显式 `REQUIRE_ADMIN_TOKEN=false` 的回环开发环境才放行。回环按连接对端 `remoteAddr` 判断，不会被同机反向代理的 `localAddr` 绕过。

## 校验命令

```bash
cd server && ../tools/mvn -B test                                        # 后端单测（242 项，实测全绿）
cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write --baseline=docs/eval/baseline-java.json"   # 检索评测 + 已提交基线门禁
cd server && ../tools/mvn -B test-compile exec:java@calibrate            # 阈值标定（改语料/同义词后必跑）
cd server && ../tools/mvn -B -q test-compile exec:java@ingest -Dexec.args="--src ./inbox --zone <展区id>"   # 资料入库（PDF/Word/txt）
python tools/smoke.py                                                    # 接口契约冒烟（需服务在跑；带 ADMIN_TOKEN 满跑 100 项）
python tools/security.py                                                 # 边界与安全（主实例 104/0/7；另起实例跑满）
python tools/db-check.py                                                 # 库层脱敏与最小权限（需 mysql 客户端）
python tools/offline-check.py --runtime                                  # 本地化不变量（除 LLM/embedding/语音外一律本地）
python tools/acceptance.py                                               # 问答内容验收（需真模型在跑，43 项）
python tools/loadtest.py --n 8 --streams 4                               # 并发/压测（多路问答+SSE+只读+中断；429 单列）
cd web && npm run build && npm run lint && npm run test:coverage          # 前端类型检查+构建、ESLint 门禁、单测+覆盖率（303 项，实测全绿）
```

Windows 上本机 `python` 命令不可用：把 `python tools/xxx.py` 改成 `py -3 tools/xxx.py`（虚拟环境里则用其 `python`）。

## 目录结构

```
znwd/
├── server/                      # Spring Boot（HTTP / RAG / LLM / 语音 / MySQL）
│   ├── db/init.sql              # 建库建最小权限账号（首次部署执行一次）
│   ├── eval/retrieval-cases.json# 检索评测用例（161 条计分）
│   ├── indexes/                 # 向量索引（本地 JSON，可重建，不入库）
│   ├── src/main/resources/prompts/  # 内置话术（可被 PROMPT_* 外部文件覆盖）
│   └── src/main/java/com/znwd/hostess/{config,embedding,knowledge,llm,audio,http,domain,repository,session,analytics,rag,web}
├── web/                         # Vue 3 + Vite：左约 1/4 形象 + 下方对话
│   └── src/{App.vue,api/,composables,components,styles.css}
├── knowledge/                   # RAG 知识正文；_meta/zones.json 管展区、_meta/synonyms.tsv 管同义词
├── tools/                       # mvn（MSYS 包装）、smoke/security/db-check/offline-check/acceptance 脚本
│   └── windows/                 # Windows 一体机启停/自启/打包脚本
├── docs/                        # 工程文档（见 docs/README.md）
└── .github/workflows/ci.yml     # CI：后端 test+评测基线+smoke+安全+库层、前端 build+test+离线检查
```

## 启动验收与日常运维

```bash
# 就绪探活：接口始终回 HTTP 200，必须读 JSON 字段，不能只看状态码（Windows 上用 curl.exe）
curl -s http://127.0.0.1:8787/api/health
# 正式验收：ok=true、ready=true、storageAvailable=true、knowledgeChunks>0
```

- **重载知识 / 重建索引 / 清答案缓存**：`POST /api/knowledge/reload`（带 `Authorization: Bearer <token>`）
- **诊断某句话为什么被拦/命中**：`GET /api/admin/diagnostics?q=…`（中文 query 用 Python 发，避免 GBK 控制台编坏）
- **备份**：`knowledge/` 必须、MySQL 建议、`server/indexes/` 不必（可重建）、`server/data/events.jsonl` 建议留档
- **升级/回滚**：换 `jar` + `web/dist` 重启；改过分块或打分时 `reload` 重建索引；数据表增量兼容，不需要回滚数据库

## 已知限制

- 只面向「展厅讲解」这一种场景：没有多租户、没有账号体系，靠 `ADMIN_TOKEN` 一把口令管运营面。
- 语义向量默认等价于关闭兜底（`MIN_VECTOR_SCORE=0.75` 当前不生效）；换语料后必须重跑 `calibrate` + `eval`，否则闸门余量会漂。
- 单实例设计：会话与限流都在进程内（最多 200 会话），不做集群共享。
- 语音依赖外部 ASR/TTS 服务（小米 MiMo），断网时只能退回浏览器合成、无法语音提问。

## 文档索引

- 部署与运维（拓扑、备份恢复、升级回滚、降级、Windows 整机步骤）：[docs/deployment.md](docs/deployment.md)
- HTTP 契约（字段表、SSE、鉴权、错误信封）：[docs/api.md](docs/api.md)
- 架构与检索流水线：[docs/architecture.md](docs/architecture.md)
- 知识库维护、分块与打分、同义词：[docs/knowledge.md](docs/knowledge.md)
- 本地开发与 CI：[docs/development.md](docs/development.md)
- 评测与阈值标定：[docs/eval.md](docs/eval.md)
- 并发与压测：[docs/loadtesting.md](docs/loadtesting.md)
- 安全口径与上线检查清单：[docs/security.md](docs/security.md)
- 待做与已知取舍：[docs/optimization-backlog.md](docs/optimization-backlog.md)
- 全部文档索引：[docs/README.md](docs/README.md)；历史快照（Node 时代功能 Spec、旧评测产物）：[docs/archive/](docs/archive/)
