# 本地开发手册

后端 Spring Boot 3.5.16（`server/`），前端 Vue 3 + Vite 6 + TypeScript（`web/`）。

## 1. 环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| JDK | **21+**（`maven.compiler.release=21`） | 本机用 JDK 25 跑通，但**语法与 API 只能用 21**（换机编译不会翻车） |
| Maven | 3.9.x | 用仓库自带的 `tools/mvn`，见下 |
| Node | 20+（本机 22） | 前端构建与单测 |
| MySQL | 8+ / 9.x，**可选** | 不装也能开发：服务照常讲解，只是不落库（`/api/health` 报 `storageAvailable=false`；前端只把它显示在运营视图的本机设置里） |

### 为什么用 `tools/mvn` 而不是 `mvn`

官方 `bin/mvn` 在 git-bash/MSYS 下走 mingw 分支，不把 `/d/Maven/...` 转成 Windows 路径，java 加载不到 `plexus-classworlds`，报「找不到主类 Launcher」。
`tools/mvn` 直接用 Windows 风格路径调 Maven 自己的 launcher 绕开它：

```bash
cd server && ../tools/mvn -B test        # 等价于 mvn -B test
```

换机器时改 `tools/mvn` 顶部的两个变量，或用环境变量覆盖：`MVN_HOME_WIN=D:/Maven/apache-maven-3.9.16`、`JAVA_HOME_WIN=D:/JDK25`。

## 2. 常用命令

| 目的 | 命令（工作目录） | 预期输出 |
| --- | --- | --- |
| 起后端 | `cd server && ../tools/mvn spring-boot:run` | `Tomcat started on port 8787` / `Started HostessApplication`；随后轮询 `/api/health`，等 `ok=true`、`ready=true` 再跑接口检查 |
| 单测 | `cd server && ../tools/mvn -B test` | `Tests run: 222, Failures: 0, Errors: 0` |
| 检索评测 | `cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write --baseline=docs/eval/baseline-java.json"` | 逐例对比已提交基线：top1/top3、闸门指标、漏答数与每条 `top1Path` 都不得退化；当前基线为 145 条计分用例、top1/top3 均 `1.0`、闸门漏答 `0` |
| 阈值标定 | `cd server && ../tools/mvn -B test-compile exec:java@calibrate` | 在域最弱 8 条、域外降序、区间与建议、**语义兜底标定**（域外最高余弦 vs 待救用例）；**区间判据与闸门口径不一致，先读 `docs/eval.md` 的说明**；`--grid` 再加 36 组参数网格；`--gate-check` 判两条线（关键词域外越线退出码 3、语义余弦越线退出码 4，CI 用的就是这条）；报告落 `docs/eval/calibration-*.json` |
| 资料入库 | `cd server && ../tools/mvn -B -q test-compile exec:java@ingest -Dexec.args="--src ./inbox --zone <展区id>"`（`--dry-run` 先看目标路径） | `完成：N/M 入库`；扫描件 PDF 与 `.doc` 明确报错；用法见 `docs/knowledge.md` §8 |
| 接口冒烟 | `python tools/smoke.py`（需服务在跑，`BASE=http://…` 可改目标；管理块要 `ADMIN_TOKEN`） | `通过 100 项，失败 0 项`（带 `ADMIN_TOKEN`、语音启用；分档口径见 §7） |
| 并发压测 | `python tools/loadtest.py`（需服务在跑；非流式/SSE/只读并发 + 客户端中断，`--duration` 可长跑） | mock 短跑（24+12）`通过 5 项，失败 0 项`；429 单列计数不算失败，口径与基线见 `docs/loadtesting.md` |
| 问答内容验收 | `python tools/acceptance.py`（需服务 + 真模型在跑；`TAGS=fix,fact` 可只跑一组） | `通过 40 项，失败 0 项`（内容层：该答的答对、该拒的拒、资料里没有的不许编；CI 跑不了，要真模型） |
| 边界与安全 | `python tools/security.py`（同上；非回环越权与误配置组见 `docs/security-testing.md`） | 主实例 `104 通过 / 0 失败 / 7 跳过`（缺第二/误配置/开发态实例）；四实例全跑 `112 通过 / 0 失败 / 0 跳过`（**推算值，本轮只起了主实例**） |
| 库层核查 | `python tools/db-check.py`（需本机 mysql 客户端：`MYSQL_BIN` 或候选路径 `D:/mysql-cli/mysql-8.4.0-winx64/bin/mysql.exe`；缺客户端整组 SKIP） | `通过 19 项，失败 0 项` |
| 本地化不变量 | `python tools/offline-check.py`（`--runtime` 追加运行期核查） | O04 后端出网白名单只含 LLM、embedding、MiMo 语音三个适配器；其它网络调用即失败 |
| 前端 dev | `cd web && npm install && npm run dev` | `VITE v6 ready`，`:5173`，`/api` 代理到 8787 |
| 前端构建 | `cd web && npm run build` | `vue-tsc -b` 类型检查 + `vite build`，产物 `web/dist` |
| 前端单测 | `cd web && npm test` | `257 passed`（13 个测试文件，含 jsdom 下的组件接线测试） |
| 前端 lint | `cd web && npm run lint` | ESLint 门禁（`web/eslint.config.mjs`，只看 `src` 下 `.ts/.vue`）**0 error**；风格类规则有意不开（仓库无 prettier） |
| 前端覆盖率 | `cd web && npm run test:coverage` | 同一批 257 项单测 + coverage 阈值门禁（阈值取实测下调 1–2 点，落在 `vite.config.ts`） |
| 打包后端 | `cd server && ../tools/mvn -B -DskipTests package` | `server/target/hostess-server.jar` |

表里 `python tools/...` 的命令在 Windows 上改用 **`py -3 tools/...`**（本机 `python` 命令不可用；虚拟环境里用其 `python`）。

评测/标定是**改语料、改同义词、改打分参数后的必跑项**；检索评测还要通过 `docs/eval/baseline-java.json` 的逐例门禁，口径见 `docs/eval.md`。

## 3. 配置读取

`server/.env` 由 `DotEnvPropertySource`（`EnvironmentPostProcessor`）读成 Spring 配置源，**沿用 Node 版的运维习惯**（现场只认这个文件，密钥也不进仓库）。

优先级：**系统环境变量 > `.env` > `application.yml` 默认值**。
查找顺序：`server/.env` → `.env`（在仓库根启动也能命中）。
`.env` 里**空值视为未配置**（`LLM_BASE_URL=` 不会把默认值覆盖成空串）。

键名以 `server/.env.example` 与 `application.yml` 为准，分七组：LLM、Embedding、语音（`AUDIO_*`）、MySQL（`DB_*`）、HTTP/前端（`HOST`/`PORT`/`WEB_DIST_DIR`/`ADMIN_TOKEN`/`REQUIRE_ADMIN_TOKEN`/`CORS_ORIGINS`）、检索（`MIN_RELEVANCE_SCORE`/`MIN_VECTOR_SCORE`/`ANSWER_CACHE_SIZE`/`UNCOVERED_LOG_SIZE`）、日志（`LOG_MAX_BYTES`/`LOG_MESSAGE_MODE`）。

`WEB_DIST_DIR`（默认 `./web/dist`）位于 HTTP/前端组：jar 直接托管该目录的前端产物、页面与 `/api` 同源（整机部署不需要静态服务器/CORS）；目录不存在时自动关闭，开发照旧 `npm run dev`。

管理鉴权默认 fail-closed：`REQUIRE_ADMIN_TOKEN=true`，未配 `ADMIN_TOKEN` 时管理请求一律 401；仅可信的回环开发环境可显式设为 `false`，且守卫按连接对端 `remoteAddr` 判回环。`CORS_ORIGINS` 仍是 Origin 白名单，预检允许 `GET,POST,PUT,DELETE,OPTIONS`，其中 `PUT` 服务于在线替换同义词表。

MySQL 首次使用：把 `server/db/init.sql` 里两处 `CHANGE_ME_znwd` 改成自定口令执行一次，再把同一口令写进 `.env` 的 `DB_PASSWORD`；建表由应用在库可达时幂等执行 `schema.sql`。

## 4. 日常改动的落点

| 要改的东西 | 落点 | 注意 |
| --- | --- | --- |
| 加/改 HTTP 接口 | `server/src/main/java/com/znwd/hostess/web/` 下对应 Controller | 错误一律抛 `ApiException`（统一信封）；同步更新 `resources/openapi.json` 与 `tools/smoke.py` |
| 检索打分参数 | `knowledge/ScoringOptions` 默认值 | **改完必须跑 `exec:java@calibrate --grid`**，别凭手感调 |
| 闸门阈值 | `.env` / `application.yml` / `HybridRetriever` 默认值 / CI 环境变量 | 四处同步；先标定再改 |
| 语义兜底阈值 | `MIN_VECTOR_SCORE` / `application.yml` / `HybridRetriever.DEFAULT_MIN_VECTOR_SCORE` / CI 环境变量 | 当前四处均为 `0.75`；改动后跑 `calibrate --gate-check` |
| 同义词 | `PUT /api/admin/synonyms`（在线，可落盘）或 `knowledge/_meta/synonyms.tsv` | 改完重跑标定与评测 |
| 虚拟形象 | 只动 `web/src/components/AvatarPortrait.vue` 内部 | 外部只吃 `state` 属性，换 3D/Live2D 不改调用方 |
| 加一张表 | `resources/schema.sql` + `domain/` 记录 + `repository/` mapper | 幂等 `CREATE TABLE IF NOT EXISTS`，由 `DatabaseStatus` 执行 |
| 加前端 API | `web/src/api/`（入口 `api/index.ts`，按 `types`/`http`/`stream`/`admin`/`speech` 拆文件）+ `composables/useChat.ts` | 字段名必须与后端一致（有 `x-request-id`、`non_null` 两个坑） |

## 5. 代码约定

- **注释写「为什么」**：能踩的坑（路径错位、非语义向量参与融合、两个入口行为不一致）都留了说明，改代码前先读注释。
- **异常**：业务错误抛 `ApiException`，`GlobalExceptionHandler` 统一成 `{error, message, requestId}`；5xx 对外只有「服务内部错误」。
- **空值**：Jackson 配了 `non_null`，null 字段不出现在响应里；新增响应字段时同步 `openapi.json`。
- **测试用合成语料**：`KnowledgeRetrievalTest` 自己造块，闸门行为才可复现；合成语料用**自己的固定阈值**（不跟生产阈值走，否则重新标定会让它无辜变红）。
- **工具类输出 UTF-8**：`RetrievalEval`/`Calibrate` 入口显式设 `System.setOut(..., UTF_8)`，否则 Windows 控制台按 GBK 花屏。
- **凭据**：`server/.env` 不进仓库、不打印、不贴日志；需要给别人看就贴 `.env.example`。

## 6. Windows 坑（踩过的）

| 现象 | 原因 | 做法 |
| --- | --- | --- |
| `curl --get --data-urlencode "q=中文"` 返回的诊断"什么都被拦" | GBK 控制台把中文参数编坏，后端收到乱码 | 用 Python 发（`urllib.parse.quote`），或直接 `python tools/smoke.py` |
| `mvn` 报「找不到主类 Launcher」 | MSYS 路径转换 | 用 `tools/mvn` |
| 从 Java 里用 `ProcessBuilder` 起 `python -c "长脚本"` 转换 Word | 实测这条命令一直不返回（本机 `python` 是 venv 里的解释器），只能等超时强杀；`pdftotext` 同样写法正常 | 不要外挂 python：`.docx` 就是 zip + `word/document.xml`，`IngestDocs.parseDocx` 用 JDK 自带 XML 解析读（保留标题层级/列表/表格），同时省掉 python-docx 这个依赖 |
| 8787 端口被占 | 上一次 `spring-boot:run` 没退干净 | `netstat -ano \| grep :8787` 找 PID，再 `MSYS_NO_PATHCONV=1 taskkill /PID <pid> /F`（不加 `MSYS_NO_PATHCONV=1` 时 `/PID` 会被 MSYS 当路径转换） |
| native 程序报「cannot change to /c/…」 | MSYS 路径不转换 | 给 native 程序传 `C:/…` 正斜杠路径，或用 `cygpath -w` |
| 临时脚本被 native 程序读不到 | `/tmp` 在 MSYS 里 | 写到 `$LOCALAPPDATA/Temp` |

## 7. 测试与 CI

### 当前口径（2026-09-29 复跑）

本机全量复跑实测，作为唯一出处，供其它文档引用：

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 后端单测 | `mvn -B test` | 224 项，0 失败/错误/跳过（2026-10-12 复核） |
| 前端单测 | `npm test` | 257 项 / 13 个文件（2026-10-12 复核；上表其余行仍为 09-29 复跑口径） |
| 前端 lint | `npm run lint` | 0 error / 0 warn（ESLint 平坦配置，见 `web/eslint.config.mjs`） |
| 前端覆盖率 | `npm run test:coverage` | 过阈值；实测 Stmts 90.94 / Branch 80.73 / Funcs 91.82 / Lines 94.22（2026-10-12 复核） |
| 前端构建 | `npm run build`（vue-tsc+vite） | 通过 |
| 接口冒烟 | `python tools/smoke.py`（带 `ADMIN_TOKEN`、语音启用） | 100 通过 / 0 失败 / 0 跳过 |
| 边界安全 | `python tools/security.py` | 主实例 104 通过 / 0 失败 / 7 跳过（2026-10-12 复跑；S16–S18、S16c、M01–M03 需另起 `SECOND_BASE`/`MISCONFIG_BASE`/`DEV_RELAXED_BASE` 三个实例，本轮未起）；四个实例全跑时按新增 10 项推算为 112 通过 / 0 失败 / 0 跳过（**非实测**，其余实例的 8 项未跑） |
| 库层 | `python tools/db-check.py` | 19 通过 / 0 失败 / 0 跳过 |
| 离线不变量 | `python tools/offline-check.py --runtime` | 7 通过 / 0 失败 / 1 跳过（O07 仅在 `LLM_PROVIDER=mock` 下有判据） |
| 内容验收 | `python tools/acceptance.py` | 40 通过 / 0 失败 |
| 检索评测 | `exec:java@eval` | 145 条计分用例（+2 开放），top1/top3 = 1.0，`gateBlockedCount=0`，与 `baseline-java.json` 逐例不一致 0 |
| 标定 | `exec:java@calibrate --gate-check` | 退出 0；关键词闸门按「排序分」口径 在域最低 6.438 / 域外最高 6.170，区间成立，余量 0.130 |
| 真机连通性套件 | — | 17 条 |
| 布局 | CSS | 实际是 `--panel-width: 25%`（约 1/4），不是 1/3 |

上表与下面命令里的 `python tools/...` 在 Windows 上改用 `py -3 tools/...`（本机 `python` 命令不可用；虚拟环境里用其 `python`）。

并发/压测不在上面的全量复跑表里（要额外的实例与限流窗口，结果随模型与限流档位浮动）：mock 短跑 `py -3 tools/loadtest.py --n 24 --streams 12 --rounds 1`、长跑（`--duration 7200`，对应 TC-PERF-07）与 429 语义见 `docs/loadtesting.md`。

```bash
cd server && ../tools/mvn -B test                     # 224 项：检索/HTTP/统计会话/同义词/诊断文案/配置接线/管理口令/降级写路径与裁剪/资料入库/请求体上限/来源面板规则/落库截断/限流键取值/语音/问答接口契约
cd web && npm run lint                                 # ESLint 门禁：src 下 .ts/.vue，0 error（风格类规则不开，取舍见 web/eslint.config.mjs）
cd web && npm test                                     # 257 项（13 个文件）：SSE 解析、问答状态机、朗读与听写、回答排版、展区下拉、界面入口与播报接线、运营视图、对话主流程、来源面板、讲解图、检索诊断与知识面板（jsdom）
cd web && npm run test:coverage                        # 同一批单测 + 覆盖率阈值门禁（阈值落在 vite.config.ts：86.5/73.5/88.5/90，实测 90.94/80.73/91.82/94.22）
python tools/smoke.py                                  # 100 项契约（需服务在跑，带 ADMIN_TOKEN、语音启用；分档口径见下）
```

冒烟项数以 `tools/smoke.py` 真实输出为准（**带 `ADMIN_TOKEN` 且语音启用才能跑满 100 项**）：带 `ADMIN_TOKEN` + 语音启用时 100 通过 / 0 失败 / 0 跳过；不带口令时管理块整组 SKIP，语音未启用时语音段按 `speechReady` 走 503 可判定分支，项数相应变化。

`CHANGELOG.md`、`docs/archive/` 等历史快照里的 56 / 61 / 64 是改动前的口径，保留原样。

CI（`.github/workflows/ci.yml`，push/PR 都跑）：

- **backend**：起一个 MySQL 8.4 service 容器 → 用 root 执行 `server/db/init.sql`（`sed` 注入口令、`@'localhost'` 换成 `@'%'`，因为容器里来源是 docker 网关 IP）→ `mvn test` → `exec:java@eval --no-write --baseline=docs/eval/baseline-java.json` → `calibrate --gate-check --no-write` → `package` → 起 jar 跑 `python3 tools/smoke.py`（先等 `/api/health` 的 `ready:true`、`storageAvailable:true` 且知识块非零）→ 另起 8899 mock 实例跑 `python3 tools/loadtest.py`（24 非流式 + 12 流式并发短跑，见 `docs/loadtesting.md`）→ 再起两个实例跑 `python3 tools/security.py`（`SECOND_BASE`/`MISCONFIG_BASE`）→ `python3 tools/db-check.py`。`LLM_PROVIDER=mock`、`MIN_RELEVANCE_SCORE=6.3`、`MIN_VECTOR_SCORE=0.75` 显式给出，失败时打印三个实例的日志。
- **frontend**：`npm ci` → `npm run build` → `npm run lint`（ESLint 0 error）→ `npm run test:coverage`（单测 + 覆盖率阈值门禁）→ `python3 tools/offline-check.py`；O04 守后端出网白名单，只允许 LLM、embedding、MiMo 语音三个适配器。

失败时的判断顺序：先在本地复现对应命令；契约类失败（smoke）先看 `docs/api.md` 的字段表，检索类失败（eval/基线门禁）先看 `REGRESSION`/`DIFF`，再跑 `calibrate` 查阈值与降级原因，边界/安全类失败（security）先看 `docs/security-testing.md` 里该编号的期望与「已接受的风险」两节，别急着改代码。

## 8. 提交约定

- **不要提交**：`server/.env`、`server/indexes/`、`server/data/`、`web/dist/`、`node_modules/`、日志文件。
- 远端：`origin` = `git@github.com:b8nw27v7wp-bit/znwd.git`（私有），主开发分支 `feature/virtual-receptionist`。
  **CI 只在 push 后才跑**（本地 `mvn test` / `npm test` 不能替代）：要用 GitHub Actions 的结果说话，就得 push。
  提交信息用中文简述「为什么改」（例：`fix(retrieval): 修非语义向量污染排序`），一个提交只做一件事。
