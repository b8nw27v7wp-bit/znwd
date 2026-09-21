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
| 起后端 | `cd server && ../tools/mvn spring-boot:run` | `Tomcat started on port 8787` / `Started HostessApplication` |
| 单测 | `cd server && ../tools/mvn -B test` | `Tests run: 60, Failures: 0, Errors: 0` |
| 检索评测 | `cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write"` | `top1Rate = 0.9333`、`top3Rate = 0.9667`、`gateBlockedCount = 0`、`minKeywordScore = 8.1` |
| 阈值标定 | `cd server && ../tools/mvn -B test-compile exec:java@calibrate` | 在域最弱 8 条、域外降序、"建议 minKeywordScore=8.1"；`--grid` 再加 36 组参数网格；报告落 `docs/eval/calibration-*.json` |
| 资料入库 | `cd server && ../tools/mvn -B -q test-compile exec:java@ingest -Dexec.args="--src ./inbox --zone <展区id>"`（`--dry-run` 先看目标路径） | `完成：N/M 入库`；扫描件 PDF 与 `.doc` 明确报错；用法见 `docs/knowledge.md` §8 |
| 接口冒烟 | `python tools/smoke.py`（需服务在跑，`BASE=http://…` 可改目标） | `通过 56 项，失败 0 项` |
| 边界与安全 | `python tools/security.py`（同上；非回环越权与误配置组见 `docs/security-testing.md`） | `通过 49 项，失败 0 项`（只跑主实例）／`57 项`（另起两个实例时） |
| 库层核查 | `python tools/db-check.py`（需本机 mysql 客户端；缺客户端整组 SKIP） | `通过 8 项，失败 0 项` |
| 本地化不变量 | `python tools/offline-check.py`（`--runtime` 追加运行期核查） | `通过 5 项，失败 0 项` |
| 前端 dev | `cd web && npm install && npm run dev` | `VITE v6 ready`，`:5173`，`/api` 代理到 8787 |
| 前端构建 | `cd web && npm run build` | `vue-tsc -b` 类型检查 + `vite build`，产物 `web/dist` |
| 前端单测 | `cd web && npm test` | `31 passed`（含 jsdom 下的组件接线测试） |
| 打包后端 | `cd server && ../tools/mvn -B -DskipTests package` | `server/target/hostess-server.jar` |

评测/标定是**改语料、改同义词、改打分参数后的必跑项**，口径见 `docs/eval.md`。

## 3. 配置读取

`server/.env` 由 `DotEnvPropertySource`（`EnvironmentPostProcessor`）读成 Spring 配置源，**沿用 Node 版的运维习惯**（现场只认这个文件，密钥也不进仓库）。

优先级：**系统环境变量 > `.env` > `application.yml` 默认值**。
查找顺序：`server/.env` → `.env`（在仓库根启动也能命中）。
`.env` 里**空值视为未配置**（`LLM_BASE_URL=` 不会把默认值覆盖成空串）。

键名以 `server/.env.example` 与 `application.yml` 为准，分六组：LLM、Embedding、MySQL（`DB_*`）、HTTP（`HOST`/`PORT`/`ADMIN_TOKEN`/`CORS_ORIGINS`）、检索（`MIN_RELEVANCE_SCORE`/`ANSWER_CACHE_SIZE`/`UNCOVERED_LOG_SIZE`）、日志（`LOG_MAX_BYTES`/`LOG_MESSAGE_MODE`）。

MySQL 首次使用：把 `server/db/init.sql` 里两处 `CHANGE_ME_znwd` 改成自定口令执行一次，再把同一口令写进 `.env` 的 `DB_PASSWORD`；建表由应用在库可达时幂等执行 `schema.sql`。

## 4. 日常改动的落点

| 要改的东西 | 落点 | 注意 |
| --- | --- | --- |
| 加/改 HTTP 接口 | `server/src/main/java/com/znwd/hostess/web/` 下对应 Controller | 错误一律抛 `ApiException`（统一信封）；同步更新 `resources/openapi.json` 与 `tools/smoke.py` |
| 检索打分参数 | `knowledge/ScoringOptions` 默认值 | **改完必须跑 `exec:java@calibrate --grid`**，别凭手感调 |
| 闸门阈值 | `.env` / `application.yml` / `HybridRetriever` 默认值 / CI 环境变量 | 四处同步；先标定再改 |
| 同义词 | `PUT /api/admin/synonyms`（在线，可落盘）或 `knowledge/_meta/synonyms.tsv` | 改完重跑标定与评测 |
| 虚拟形象 | 只动 `web/src/components/AvatarPortrait.vue` 内部 | 外部只吃 `state` 属性，换 3D/Live2D 不改调用方 |
| 加一张表 | `resources/schema.sql` + `domain/` 记录 + `repository/` mapper | 幂等 `CREATE TABLE IF NOT EXISTS`，由 `DatabaseStatus` 执行 |
| 加前端 API | `web/src/api.ts` + `composables/useChat.ts` | 字段名必须与后端一致（有 `x-request-id`、`non_null` 两个坑） |

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

```bash
cd server && ../tools/mvn -B test                     # 60 项：检索/HTTP/统计会话/同义词/诊断文案/配置接线/管理口令/降级写路径与裁剪/资料入库
cd web && npm test                                     # 37 项：SSE 解析、问答状态机、朗读切片、回答排版、展区下拉、界面入口与播报接线（jsdom）
python tools/smoke.py                                  # 56 项契约（需服务在跑）
```

CI（`.github/workflows/ci.yml`，push/PR 都跑）：

- **backend**：起一个 MySQL 8.4 service 容器 → 用 root 执行 `server/db/init.sql`（`sed` 注入口令、`@'localhost'` 换成 `@'%'`，因为容器里来源是 docker 网关 IP）→ `mvn test` → `exec:java@eval --no-write` → `package` → 起 jar 跑 `python3 tools/smoke.py`（先断言 `storageAvailable:true`，库没连上就直接失败）→ 再起两个实例跑 `python3 tools/security.py`（`SECOND_BASE`/`MISCONFIG_BASE`）→ `python3 tools/db-check.py`。`LLM_PROVIDER=mock`、`MIN_RELEVANCE_SCORE=8.1` 显式给出，失败时打印三个实例的日志。
- **frontend**：`npm ci` → `npm run build` → `npm test`

失败时的判断顺序：先在本地复现对应命令；契约类失败（smoke）先看 `docs/api.md` 的字段表，检索类失败（eval）先跑 `calibrate` 看阈值区间是否还成立，边界/安全类失败（security）先看 `docs/security-testing.md` 里该编号的期望与「已接受的风险」两节，别急着改代码。

## 8. 提交约定

- **不要提交**：`server/.env`、`server/indexes/`、`server/data/`、`web/dist/`、`node_modules/`、日志文件。
- 远端：`origin` = `git@github.com:b8nw27v7wp-bit/znwd.git`（私有），主开发分支 `feature/virtual-receptionist`。
  **CI 只在 push 后才跑**（本地 `mvn test` / `npm test` 不能替代）：要用 GitHub Actions 的结果说话，就得 push。
  提交信息用中文简述「为什么改」（例：`fix(retrieval): 修非语义向量污染排序`），一个提交只做一件事。
