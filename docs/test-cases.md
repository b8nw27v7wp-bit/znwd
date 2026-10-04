# 智能问答项目全幅度测试用例

这份文档是**整个项目（后端 API / RAG 检索 / 知识库 / 语音 / 前端 UI / 数据层 / 部署离线）的全幅度测试用例设计**：
按功能域分组给出用例编号、步骤、预期、优先级与自动化归属，并在末尾给出「用例 ↔ 自动化脚本」覆盖映射与缺口清单。

与现有测试文档的分工：

| 文档 / 载体 | 定位 |
| --- | --- |
| [security-testing.md](./security-testing.md) | 边界与安全用例（B/S/G/V/W/X/Y 编号）的**期望与实测结果记录** |
| [eval.md](./eval.md) | 检索评测与阈值标定的**指标口径与基线** |
| **本文（test-cases.md）** | **全幅度用例设计总表**：每条用例属于哪一层、由谁自动化、还剩什么没覆盖 |

> 本文只写「怎么测、期望什么、谁来跑」，不重复记录某次实测通过数——实测结果看各脚本当次输出与
> `docs/security-testing.md`、`CHANGELOG.md`。活文档（README / development / eval / api 等）的数字已按实际输出统一；
> 历史快照（`CHANGELOG.md`、`docs/archive/`、交接文档）里仍留着旧数字（如后端单测 83、冒烟 56/61/64），
> **一律以实际运行输出为准**。

## 0. 使用说明

### 0.1 测试层次与已有自动化

| 层 | 载体 | 命令 | 覆盖面 |
| --- | --- | --- | --- |
| 单元层 | JUnit（`server/src/test`） | `cd server && ../tools/mvn -B test` | 检索打分、闸门、分块、降级、入参解析、限流、CORS、日志脱敏、管理守卫、LLM 重试、会话统计（合成语料，可复现） |
| 单元层 | Vitest（`web/src/**/*.spec.ts`） | `cd web && npm test` | SSE 解析状态机、问答状态机、排版 XSS、朗读/听写、组件接线（jsdom） |
| 检索评测层 | `server/eval` 评测与标定 | 在 `server/` 下：`../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write --baseline=docs/eval/baseline-java.json"`；`exec:java@calibrate -Dexec.args="--gate-check --no-write"` | 真实语料 top1/top3、追问改写收益、域外拒答门禁、阈值余量 |
| 契约层 | `tools/smoke.py` | `python tools/smoke.py`（服务在跑） | 字段、状态码、SSE 事件序列、诊断与同义词热更新 |
| 边界/安全层 | `tools/security.py` | `python tools/security.py`（可带 `SECOND_BASE`/`MISCONFIG_BASE`） | 畸形输入、越界参数、注入、越权、脱敏、限流、SSE 边界、语音边界 |
| 库层 | `tools/db-check.py` | `python tools/db-check.py`（需 mysql 客户端） | 五表、最小权限、chat_log 脱敏形态、uncovered 原文 |
| 离线层 | `tools/offline-check.py` | `cd web && npm run build` 后 `python tools/offline-check.py`（`--runtime` 追加运行期核查） | 产物无联网引用、后端出网白名单、依赖无遥测 |
| 内容层 | `tools/acceptance.py` | 需真实模型（`server/.env` 配 `LLM_PROVIDER=openai_compat` 等）后 `python tools/acceptance.py` | 该答的答对、该拒的拒、资料里没有的不编（**需真模型，不进 CI**） |
| 集成层 | GitHub Actions（`.github/workflows/ci.yml`） | push 后自动 | backend + frontend 两条流水线 |
| 手工层 | **本文标注「手工」的用例** | 见各组 | 前端真实交互、降级演练、部署验收、长时间运行等无法黑盒脚本化的部分 |

### 0.2 环境准备

```bash
# 1) MySQL 首次：执行 server/db/init.sql 建库建账号（日常启动 MySQL 服务即可）
# 2) 后端（默认 mock 模型 + bag 词面，展厅安全演示档）
cd server && ../tools/mvn -B spring-boot:run          # 默认 127.0.0.1:8787
# 3) 前端
cd web && npm run dev                                  # Vite 代理 /api → 127.0.0.1:8787
# 4) 黑盒脚本（仓库根目录，另开终端）
python tools/smoke.py
python tools/security.py
python tools/db-check.py
```

- 内容层验收（TC-QUAL）需在 `server/.env` 配置真实 LLM 后再起服务。
- 中文参数用 curl 直发会因 GBK 控制台乱码，`/api/admin/diagnostics?q=中文` 请用 Python 发或走 `smoke.py`（见 `docs/development.md` Windows 坑一节）。
- 静态阈值断言与 CI 同源：`MIN_RELEVANCE_SCORE=6.3`、`MIN_VECTOR_SCORE=0.75`（改动需四处同步，见 TC-DEP-04）。

### 0.3 执行顺序与硬约束

1. `smoke → security → db-check` **必须串行**：security 的 F 组会刻意打满 30 次/分钟限流，db-check 并行跑会撞 429 表现成一片 SKIP。
2. `offline-check` 必须在 `npm run build` 之后（O01–O03 查 `web/dist`）。
3. 跑完 security 中断了的话，等约 1 分钟限流窗口滑过再手工验证。
4. **本地全绿 ≠ 可发布**：CI 只在 push 后跑；远端 CI 全绿才算集成验证通过。

### 0.4 优先级与覆盖标记

- **P0**：发布阻断，任何一条不过即不放行。
- **P1**：核心功能/降级路径，发布前应全过。
- **P2**：增强、运维、体验项，允许带记录遗留。
- 覆盖标记：`smoke`/`security`/`db-check`/`offline`/`mvn`/`vitest`/`eval`/`calibrate`/`acceptance`/`CI` 表示已自动化（括号内为脚本内编号或类名）；`手工` 表示人工执行；`建议自动化` 表示当前无脚本覆盖、值得补。

## 1. 用例编号总表

| 组 | 编号前缀 | 范围 | 条数（约） |
| --- | --- | --- | --- |
| 启动与就绪 | `TC-PRE-` | 服务健康、前端可访问、离线产物 | 5 |
| 非流式问答 | `TC-CHAT-` | `POST /api/chat` 契约与行为 | 11 |
| 流式问答 | `TC-SSE-` | `POST /api/chat/stream` 协议与前端流渲染 | 12 |
| 会话与多轮 | `TC-SES-` | 会话 CRUD、指代改写、裁剪、恢复 | 11 |
| 反馈 | `TC-FBK-` | `POST /api/feedback` 与统计回流 | 7 |
| 知识库与检索 | `TC-KB-` | list/reload/诊断/评测门禁 | 13 |
| 同义词管理 | `TC-SYN-` | 同义词读写与热生效 | 7 |
| 公开元数据 | `TC-META-` | health/suggestions/zones/openapi/CORS | 7 |
| 管理与统计 | `TC-ADM-` | AdminGuard/stats/uncovered/feedback-stats | 7 |
| 语音 | `TC-SPK-` | TTS/ASR 接口 + 前端朗读/听写 | 11 |
| 前端 UI | `TC-UI-` | 聊天交互、渲染、错误、运营抽屉、布局 | 17 |
| 边界与安全 | `TC-SEC-` | 映射 `security.py` 编号 + 已接受风险记录 | 9 |
| 数据与隐私 | `TC-DB-` | 库层脱敏、最小权限、备份恢复 | 9 |
| 降级与容错 | `TC-DGR-` | DB/LLM/知识库/embedding/语音故障注入 | 12 |
| 性能与并发 | `TC-PERF-` | 延迟、限流、缓存、长跑 | 8 |
| 部署与离线 | `TC-DEP-` | 一体机验收、出网白名单、反代、阈值同步 | 8 |
| 内容质量 | `TC-QUAL-` | acceptance 六组 + eval 指标门禁 | 6 |

合计约 **160 条**。带 `自动化` 标记的由对应脚本/测试类执行；`手工` 与 `建议自动化` 是本文新增的覆盖面。

## 2. 用例正文

### TC-PRE 启动与就绪

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-PRE-01 | `GET /api/health` | 恒 HTTP 200；JSON 内 `ok=true`、`ready=true`、`knowledgeChunks>0`、`storage="mysql"`、`storageAvailable=true`、`version=1.3.0`、`llmProvider`、`embeddingReady`、`retrieval`、`adminTokenRequired`、`uptimeSec` 齐全 | P0 | smoke + CI |
| TC-PRE-02 | 起 `npm run dev`，浏览器打开首页 | 页面 200、无 console 报错、无失败的静态请求；聊天输入框与发送可用，讲解图渲染 | P0 | 手工（App.spec 覆盖接线） |
| TC-PRE-03 | `npm run build` 后 `python tools/offline-check.py` | O01–O03 全过：`web/dist` 无联网 URL/CDN/埋点域名，`index.html` 只引相对路径 | P0 | offline + CI |
| TC-PRE-04 | `GET /api/health/summary`（匿名） | 200；`{chatTotal, noHit, activeSessions, retrieval}` 字段齐全 | P1 | smoke |
| TC-PRE-05 | 默认演示档自洽检查：读 `/api/health` | `llmProvider=mock` 时 `embeddingReady=false`、`retrieval.mode=keyword`（bag 词面）；`ready`/`knowledgeChunks` 仍为真——即「没配真模型不等于没就绪」 | P1 | 建议自动化（offline `--runtime` O06 已覆盖语义路自洽） |

### TC-CHAT 非流式问答（`POST /api/chat`）

> 前端只走 SSE，本组保的是**工具脚本与第三方调用依赖的非流式契约**（字段表见 `docs/api.md`）。

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-CHAT-01 | 在域问题，如 `{"message":"清洁机器人单次清洗多重"}` | 200；`answer` 非空、`sources[]` 非空、`mode="rag"`、`noHit=false`、`provider`=模型名、`retrieval`∈{keyword,hybrid}、`latencyMs≥0`、`cached=false`、`rewrite{rewritten,reason,carriedTokens}` 齐全 | P0 | smoke |
| TC-CHAT-02 | 缺 `message` / `message` 非字符串 / 空白串 | 400 `validation_error`，统一信封 `{error,message,requestId}`，非 500 | P0 | smoke + security B01–B03 |
| TC-CHAT-03 | body 是数组 `[1,2,3]` / 非法 JSON | 400；不泄漏异常类名、无 `Exception`/`java.` 字样 | P0 | security B04/B05 |
| TC-CHAT-04 | `message` 恰好 2000 字 / 2001 字 | 2000 字：200 且不截断；2001 字：200 且截断到 2000（日志 `messageLen=2000`） | P1 | security B07–B10 |
| TC-CHAT-05 | `sessionId` 含 `<script>`、`/`、超长 80 字符 | 清洗为 `[A-Za-z0-9._-]{1,64}` 后回显；全非法字符视为未传（响应无 `sessionId`） | P1 | security B13/B14 |
| TC-CHAT-06 | 控制字符、零宽、RTL 覆写、4 字节 emoji | 200/400，不 5xx | P1 | security B15 |
| TC-CHAT-07 | 域外问题，如 `{"message":"讲个笑话"}` | 200；`noHit=true`、`sources=[]`、`provider="gate"`、`answer`=固定拒答文案（不调模型） | P0 | smoke |
| TC-CHAT-08 | 同一单轮问题（不带历史）连发两次 | 第二次 `cached=true`；答案内容一致 | P1 | smoke 11) 缓存行为组 |
| TC-CHAT-09 | 带 `sessionId` 的第二问（有历史） | `cached=false`（缓存只对无历史单轮生效） | P1 | smoke 11) 缓存行为组 |
| TC-CHAT-10 | 在域问题后立刻 `POST /api/knowledge/reload`，再问同一问题 | reload 后索引 generation 变、缓存 key 变 → `cached=false`，可拿到新结果 | P1 | smoke 14) reload 组 |
| TC-CHAT-11 | 观察所有响应头 | 带 `x-request-id`，与错误体 `requestId` 一致；`x-content-type-options: nosniff` | P1 | security（S 组）+ 建议自动化 |

### TC-SSE 流式问答（`POST /api/chat/stream`）

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-SSE-01 | 正常在域问题走流式 | 200；`Content-Type: text/event-stream`；事件序列严格 `meta → delta* → done`；`done.answer` 非空；`done` 是 `meta` 超集（含 `rewrite`、`usage`） | P0 | smoke + security G02 |
| TC-SSE-02 | 检查响应头 | `x-accel-buffering: no`（防反代缓冲）；`x-request-id` 存在 | P0 | security G04 |
| TC-SSE-03 | 首帧 `meta` 字段校验 | 含 `mode/provider/retrieval/noHit/sessionId` 等契约字段，缺字段前端视为协议错误 | P0 | smoke + vitest `api.spec` |
| TC-SSE-04 | 发坏 JSON / 空 message | 400 统一信封（不进 SSE 流） | P0 | security G01 |
| TC-SSE-05 | 客户端读到一半主动断开（`curl --max-time 2` 或浏览器刷新） | 服务存活（health 仍 200）、日志无 ERROR、不泄漏线程 | P0 | security G07 |
| TC-SSE-06 | 等待超过 15s 的慢请求 | 有 `:ping` 心跳注释帧（每 15s），连接不被中间层掐断 | P1 | 手工 |
| TC-SSE-07 | LLM 上游故障（错误的 `LLM_BASE_URL` 起服务） | 流中出现 `error` 帧（或 HTTP 错误），带可读 message；前端大屏给友好句、技术原因进运营视图 | P0 | 手工 + `OpenAiCompatChatModelTest` + TC-DGR-03 |
| TC-SSE-08 | 模型返回空正文 | 后端判失败（不发空 `done.answer`）；前端报协议错 | P1 | `OpenAiCompatChatModelTest` + vitest |
| TC-SSE-09 | 前端解析乱序帧：delta 先于 meta / 重复 meta / done 后尾随帧 / done 前 EOF / `done.answer` 空 | 一律抛协议错，不当成功处理，不产生半截消息污染 | P0 | vitest `api.spec`（前端状态机） |
| TC-SSE-10 | 跨 chunk 半帧、CRLF/LF 混合边界、心跳注释帧 | 解析正确不串帧 | P1 | vitest `api.spec` |
| TC-SSE-11 | 流超过前端 180s 超时（`STREAM_TIMEOUT_MS`） | 前端中止请求并给友好错误；服务端按客户端断开收尾 | P1 | `App.spec` TC-SSE-11（前端中止+运营视图可见原因；服务端侧仍手工） |
| TC-SSE-12 | 域外问题走流式 | `meta.noHit=true`、`provider="gate"`、`delta` 直接给固定拒答文案 | P0 | smoke |

### TC-SES 会话与多轮

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-SES-01 | 同 `sessionId` 连续两问，第二问用指代（「那它呢」「刚才说的呢」） | 第二问 `rewrite.rewritten=true` 且 `reason≠none`；答案按上下文补全 | P0 | smoke |
| TC-SES-02 | `GET /api/sessions/{id}`（存在时） | 200；`{sessionId, messages[{role,content}], lastActive}`；只读不刷 TTL | P1 | 手工（前端不调用此接口） |
| TC-SES-03 | `GET /api/sessions/{不存在或已过期}` | 404 `not_found` 统一信封 | P1 | security B21 |
| TC-SES-04 | 会话闲置超过 10 分钟后再 GET | 404（TTL 过期；启动 restore 也只恢复未过期会话） | P1 | `SessionStoreTest.restore加载的过期会话不可访问而活跃会话可读`（mvn） |
| TC-SES-05 | `DELETE /api/sessions/{存在}` → 再 GET | 第一次 `{ok:true}`；随后 GET 404 | P1 | smoke 12) 会话契约组 |
| TC-SES-06 | `DELETE /api/sessions/{不存在}` | 200 且 `{ok:false}`——**不算错误**（与 GET 404 语义不同，属既定契约） | P1 | smoke 12) 会话契约组（含带错令牌仍 200 不泄露存在性） |
| TC-SES-07 | 同一会话连问 7 轮后 GET | 只保留最近 6 轮（`MAX_TURNS=6`），`seq` 单调 | P1 | `AnalyticsSessionTest` + 手工复核 |
| TC-SES-08 | 累计超过 12 条消息历史后再问 | prompt 历史被裁剪（`MAX_HISTORY_MESSAGES=12`），回答不因超长历史失败 | P2 | 手工 |
| TC-SES-09 | 有活跃会话时重启后端 | 未过期会话从 MySQL 恢复（GET 仍 200、历史仍在）；过期的被清理 | P1 | 手工 |
| TC-SES-10 | 同一会话并发 6 个提问 | 全部 200/429，无 5xx；答案互不串台（前端代际隔离） | P1 | security B23 |
| TC-SES-11 | 拿到猜测的 sessionId 直接 GET、DELETE | ① 会话**存在且下发过令牌**：不带/带错 `X-Session-Token` 一律 404（不承认该 id 有效，403 反而成了枚举器）；② 会话**从未下发令牌**（重启恢复的老会话）：仍可读可删——这一条是已接受风险（单屏展厅设计，见 `docs/security.md`） | P1 | security S19/S19a–d + `ChatWebContractTest` + `useChat.spec` 会话归属令牌组（前端在 `done` 帧收令牌、DELETE 时带回） |

### TC-FBK 反馈

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-FBK-01 | `{"rating":"up","sessionId":…,"question":…}` | 200 `{"ok":true}` | P0 | smoke |
| TC-FBK-02 | `rating` 非法（`"UP"`、缺字段、非字符串） | 400 `validation_error` | P0 | smoke + security B17/B18 |
| TC-FBK-03 | `comment` 5000 字 | 截断后 200 | P1 | security B19 |
| TC-FBK-04 | 缺 `question` 提交（只带 sessionId） | 服务端取该会话最后一问补全 | P1 | 手工 + vitest（前端带上上一问） |
| TC-FBK-05 | 提交若干 up/down 后查 `GET /api/stats` | `feedback{up,down}` 同步累加 | P1 | smoke 13) 统计联动组 |
| TC-FBK-06 | `GET /api/admin/feedback-stats` 与 `?format=csv` | JSON 含 `{total,up,down,downRate,topDown,recent}`；CSV 返回附件格式 | P2 | 手工 |
| TC-FBK-07 | 前端点「有帮助/没帮助」后提交失败（断网模拟） | 按钮状态回滚，可重试；不出现幽灵状态 | P1 | vitest `useChat.spec` |

### TC-KB 知识库与检索

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-KB-01 | `GET /api/knowledge/list`（带 `ADMIN_TOKEN`；不带口令另测） | 带口令 200；`{knowledgeDir, fileCount, chunkCount, retrieval, zones, synonyms, docs[]}`；`chunkCount>0`、`synonyms.count>0`、`docs` 每项含 `path/title/zone/chunks`；**不带口令 → 401 `unauthorized`**（该接口已过 `AdminGuard`） | P0 | smoke（带口令时的管理块）+ security `ADMIN_PATHS` |
| TC-KB-02 | `GET /api/admin/diagnostics?q=<在域问题>`（带 Bearer） | 200；字段 `query/topK/hits/gated/mode/reason/semantic/thresholds/distanceToGate/verdict` 齐全；在域 `gated=false`、`hits` 非空 | P0 | smoke |
| TC-KB-03 | `GET /api/admin/diagnostics?q=<域外问题>` | `gated=true`、`verdict` 含「闸门」字样、`hits=[]` | P0 | smoke |
| TC-KB-04 | 诊断缺 `q`；`topK=0/-5/999/abc` | 缺 q → 400；topK 夹取到 1–20（`0→1`、`-5→1`、`999→20`），非数字 → 400 | P1 | smoke + security B16 |
| TC-KB-05 | 诊断不带 Bearer / 错误 Bearer（非回环） | 401 `unauthorized` 统一信封 | P0 | security S15–S18 + 建议自动化 |
| TC-KB-06 | `POST /api/knowledge/reload`（带正确 Bearer） | 200；`{ok, knowledgeChunks, generation, retrieval, synonyms, files[]}`；`generation` 比之前 +1；答案缓存被清 | P1 | smoke 14) reload 组 |
| TC-KB-07 | 把 `KNOWLEDGE_DIR` 指向空目录后 reload | 保留旧代（旧索引仍可答），本次报错——**不许把空库覆盖成新快照** | P0 | `RagBackendSnapshotTest` + 手工 |
| TC-KB-08 | 新增/修改一篇 `knowledge/**/*.md` → reload → 问新内容 | 新内容可被检索命中（zone/路径符合 `knowledge/_meta/zones.json` 映射）；`fileCount`/`chunkCount` 变化 | P0 | 手工（`docs/knowledge.md` 必做流程） |
| TC-KB-09 | reload 后跑 `exec:java@eval --no-write --baseline=docs/eval/baseline-java.json` | 相对基线无 `REGRESSION`，`top1Rate/top3Rate/gateBlockedCount` 达标 | P0 | eval + CI |
| TC-KB-10 | `exec:java@calibrate --gate-check --no-write` | 通过；域外关键词分不越线（越线退出码 3）、语义余弦不越线（退出码 4） | P0 | calibrate + CI |
| TC-KB-11 | 换 provider（`EMBED_PROVIDER` bag↔openai_compat）重启或 reload | 索引按 provider 分文件，切换后重建/加载对应索引；`retrieval.mode` 与 `embeddingReady` 自洽 | P1 | `RagBackendSnapshotTest` + 手工 |
| TC-KB-12 | `KNOWLEDGE_WATCH=true` 时直接改 md 文件 | 10s 内指纹比对自动热更，无需手动 reload 即可命中新内容 | P2 | 手工 |
| TC-KB-13 | 在域问题的 `sources[]` 内容 | 按 `sourcePath` 去重；只保留分数 ≥ 最高分 × 0.5 的来源；`snippet` ≤200 字；`sources.length` 是资料份数而非命中块数 | P1 | `RagPipelineTest` + smoke 字段核对 |

### TC-SYN 同义词管理

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-SYN-01 | `GET /api/admin/synonyms`（带 Bearer） | 200；`{count, source, file, entries[], tsv}`；`count>0` | P1 | smoke |
| TC-SYN-02 | `PUT /api/admin/synonyms` 加探针词（如把 `ZWPROBE` 关联到某在域术语） | 200 `{ok:true}`；**立即生效**：含探针词的提问诊断抬分（`gated=false` 或 `distanceToGate` 变化），无需重启 | P1 | smoke |
| TC-SYN-03 | 还原（删掉探针词）后再测 | 分数回落到加词前水平 | P1 | smoke |
| TC-SYN-04 | `PUT` 空表（`lines` 空且 `entries` 空）/ 非法行 | 400 `validation_error` | P1 | smoke + 建议自动化 |
| TC-SYN-05 | `PUT`（默认 `persist=true`）后查 `knowledge/_meta/synonyms.tsv` | 落盘成功，重启后仍生效（`source` 字段变化） | P1 | 手工 |
| TC-SYN-06 | 同义词变更后重问此前 `cached=true` 的问题 | 缓存已清（答案服务调用了 `invalidateAnswerCache`），可反映新同义词 | P1 | 手工 |
| TC-SYN-07 | `PUT /api/admin/synonyms` 不带/错 Bearer | 401，且同义词文件未被改动 | P0 | 建议自动化 |

### TC-META 公开元数据（匿名可访问）

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-META-01 | `GET /api/suggestions` 与 `?zone=<展区>` | 200；`{items:[string], zone}`，`items` 是字符串数组；zone 过滤返回该展区推荐问题 | P0 | smoke |
| TC-META-02 | `GET /api/zones` | 200；`{zones[], media[]}`；与 `knowledge/_meta/zones.json` 一致 | P0 | smoke + vitest（展区下拉） |
| TC-META-03 | `GET /api/openapi.json` | 200；覆盖全部对外路径，与实际路由一致（加接口必须同步，见 `docs/development.md` 落点表） | P1 | smoke + P2 抽查对照 |
| TC-META-04 | 未知路由（含中文路径）、错方法（`PUT /api/chat`） | 404 `not_found` / 405 `method_not_allowed`（带 `allowed[]`），统一信封 | P0 | security B20/B22 |
| TC-META-05 | 恶意 `Origin` 请求 | 不回 `Access-Control-Allow-Origin`；本地合法 Origin 回显；始终不带 `allow-credentials` | P0 | security S12–S14 |
| TC-META-06 | `Accept` 协商失败 / 错 `Content-Type` | 406 / 415 统一信封 | P1 | 建议自动化 |
| TC-META-07 | 限流打满期间再访问 suggestions/zones/health | 只读接口**不受**聊天限流影响，仍 200 | P0 | security S22 |

### TC-ADM 管理与统计（需 `Authorization: Bearer <ADMIN_TOKEN>`）

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-ADM-01 | 非回环地址访问任一管理口：无口令 / 错口令 / 正确口令 | 401 / 401 / 200——**fail-closed**（常量时间比较） | P0 | security S15–S18 + CI 三实例 |
| TC-ADM-02 | 绑 `HOST=0.0.0.0` 但**未配** `ADMIN_TOKEN` 的实例 | 管理口全部 401（不因缺配置放行）；前台接口（zones/suggestions/chat）不受影响 | P0 | security M01–M03 |
| TC-ADM-03 | 错口令连续试错 >20 次/60s | 429 `rate_limited`（试错限流），正确口令随后也暂时 429 | P1 | 建议自动化 |
| TC-ADM-04 | `GET /api/stats` | 200；`uptimeSec/chatTotal/ragHits/llmOnly/noHit/rewritten/uncoveredCount/tokens{prompt,completion,reasoning,total,calls}/errors/activeSessions/feedback/recent[]` 齐全，数值与实际问答对得上 | P1 | smoke 13) 统计联动组（12 字段逐项 + 增量对账） |
| TC-ADM-05 | `GET /api/admin/uncovered` | 200；`{count, items[{at,sessionId,question}]}` 按新→旧；闸门拦下的原话确实在列（存明文是设计） | P1 | db-check D08 交叉验证 |
| TC-ADM-06 | `GET /api/admin/feedback-stats`（`?format=csv`） | 见 TC-FBK-06 | P2 | 手工 |
| TC-ADM-07 | 前端 `?admin=1` 打开运营抽屉：错口令 / 对口令 | 错：显示「口令不正确」；对：拉取 stats/uncovered/feedback-stats 成功；口令只进 sessionStorage、不进 URL/日志 | P1 | vitest `AdminPanel.spec` + 手工 |

### TC-SPK 语音（TTS/ASR + 前端朗读/听写）

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-SPK-01 | `POST /api/speech/synthesize`（`AUDIO_PROVIDER=mimo`，正常文本） | 200 `audio/wav`，体 >44 字节且以 `RIFF….WAVE` 开头；响应头 `x-znwd-speech: live\|cache` | P0 | security V 组 + smoke |
| TC-SPK-02 | 同文本再次合成 | 命中缓存（`x-znwd-speech: cache`），内容不串音 | P1 | security V 组 |
| TC-SPK-03 | `AUDIO_PROVIDER=none` 时合成/识别 | 503 `speech_unavailable`（可判定，前端降级浏览器引擎/隐藏能力） | P0 | smoke + security V 组 |
| TC-SPK-04 | 合成文本空 / >300 字（`AUDIO_MAX_CHARS`） | 400 `validation_error` | P1 | security V 组 |
| TC-SPK-05 | 上游语音故障（错误的音频配置） | 502 `speech_failed`；服务不 500 | P1 | `MimoSpeechModelTest` + 手工 |
| TC-SPK-06 | `POST /api/speech/recognize` 正常 WAV | 200 `{text, seconds, elapsedMs}` | P0 | security Y 组 |
| TC-SPK-07 | 识别：缺 audio / 非 WAV / 坏 base64 | 400 `validation_error` | P1 | security Y 组 |
| TC-SPK-08 | 识别：>2MB 录音 | 413 `payload_too_large`（语音路径放宽到 2MB，其它路径仍 64KB） | P1 | security W/X 组 + smoke |
| TC-SPK-09 | recognize 与 chat 共用配额：同 IP 打满 30 次/分钟 | 识别与聊天同时 429；TTS 独立配额 60 次/分钟 | P1 | 手工 + 建议自动化 |
| TC-SPK-10 | 前端朗读：流式回答结束 → 自动朗读；关开关；点停止 | 按句切片朗读；开关状态持久化（localStorage）；停止立即静音；「重新开始」停读清屏 | P1 | vitest `useSpeech`/`App.spec` + 手工 |
| TC-SPK-11 | 前端听写：安全上下文（https/localhost）点麦克风 → 说话 → 识别 → 自动发问；非安全上下文（内网 http IP） | 安全上下文：出 16kHz WAV、识别文本进输入框并发问；非安全上下文：麦克风按钮**不出现**；自动播放被浏览器拦截时降级不报错 | P1 | vitest `useDictation` + 手工 |

### TC-UI 前端界面（Vue 3 单页，手工为主）

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-UI-01 | 输入问题按 Enter；Shift+Enter；只输空白 | Enter 发送；Shift+Enter 只换行；空白不发请求 | P0 | vitest `App.spec` + 手工 |
| TC-UI-02 | 发送后观察 | textarea 禁用、出现「正在回答…」占位与「停」按钮；形象切 thinking 态；流式光标随 delta 前进；自动滚到底部 | P0 | vitest + 手工 |
| TC-UI-03 | 流结束 | 按钮/输入恢复；消息补上 `latencyMs` 与来源入口「查看来源（N）」 | P0 | vitest `useChat.spec` + 手工 |
| TC-UI-04 | 点「停」 | 请求中止；已收到的半句保留并标注中止；界面立即可再发 | P0 | vitest `cancel` + 手工 |
| TC-UI-05 | 回答含 Markdown（粗体/列表/分段/代码围栏） | 渲染成对应块；去掉标题记号与围栏；落单 `**` 不破坏布局 | P1 | vitest `format.spec` |
| TC-UI-06 | 回答/来源片段里注入 `<img src=x onerror=…>`、`<a href>`、粗体闭合属性 | **DOM 中不出现任何元素**，全部按文字显示（排版器不产出 HTML；链接不产出 href） | P0 | vitest `format.spec`/`App.spec` + 手工 |
| TC-UI-07 | 展开来源面板 | 显示标题、片段、展区、分数（融合/语义/关键词）；无来源时给一句说明 | P1 | vitest `SourcePanel.spec` + 手工 |
| TC-UI-08 | 点推荐问题 chips | 文本进输入框并直接发送 | P1 | vitest `App.spec` |
| TC-UI-09 | 切换展区下拉 | 推荐问题按 zone 过滤；快速连续切换不出现旧请求覆盖新请求（竞态） | P1 | `useChat.spec` 展区切换竞态组（真点击路径仍手工） |
| TC-UI-10 | 失败时（后端 5xx/断流） | 大屏只给友好句「这条问题暂时没能回答，请再试一次。」；**保留已收到的半句**；技术原因进运营视图「最近的技术问题」（上限 20 条），大屏不露堆栈 | P0 | vitest `useChat.spec`/`App.spec` + 手工 |
| TC-UI-11 | 后端 health 不可达时刷新页面 | 页面仍可打开；存储状态显示「未知（后端未响应）」一类文案，不白屏不 panic | P1 | `App.spec` TC-UI-11 |
| TC-UI-12 | 连续追问多次 | 同一 sessionId 贯穿（localStorage `znwd.sessionId`）；反馈始终带上**上一问** | P1 | vitest `App.spec` |
| TC-UI-13 | 点「重新开始」 | 调 `DELETE /api/sessions/:id`、换新 sessionId、清屏、停朗读；重置期间（resetting）输入禁用、拒新 ask；重置失败也清本地并可继续用 | P0 | vitest `useChat.spec` + 手工 |
| TC-UI-14 | 闲置 180 秒不操作 | 自动复位（清屏换会话），回到初始欢迎态 | P2 | `App.spec` TC-UI-14（假定时器推进 180s，含手势重置计时器） |
| TC-UI-15 | URL 不带 `?admin=1` / 带 `?admin=1` | 无运营入口；带参才出现抽屉，且不刷新不丢 | P1 | vitest `App.spec` |
| TC-UI-16 | 三档分辨率（1280×800 / 1600×900 / 1920×1080） | 左约 1/4（`--panel-width: 25%`）形象+对话、右侧讲解图布局不塌（对照 `.run/` 存档截图） | P2 | 手工 |
| TC-UI-17 | 全程观察 console 与网络面板 | 无未捕获异常、无 404 静态资源；`VITE_API_BASE_URL` 配置后 API 前缀拼接正确（去尾斜杠、不双写 `/api`） | P1 | `apiUrl.spec` TC-UI-17（前缀拼接 4 条；console/404 仍手工） |
| TC-UI-18 | 中文输入法组字中按回车（选词那一下） | **不提交**，草稿留在输入框；组字结束后的回车才提交——否则半截拼音会被当成问题发出去 | P1 | `App.spec` 输入法组字用例 |

### TC-SEC 边界与安全（映射 `tools/security.py`）

> 本组是**映射表**：脚本内编号即用例 ID，期望与实测记录见 `docs/security-testing.md`。执行方式见 §0.3。
> 「已接受风险」行的预期是**确认仍然按设计放行**，防止未来被误修成拦截（或反之）。

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-SEC-01 | 畸形输入全家桶（空白/类型错/对象/数组/坏 JSON/2000-2001 字/sessionId 清洗/控制字符/超大 body） | 见 TC-CHAT-02~06；全程无 5xx、无异常类名泄漏 | P0 | security B01–B15 |
| TC-SEC-02 | 注入与探测：SQL 串、路径穿越（`../../`、`/api/../`）、堆栈诱饵、密钥诱饵 | 不 5xx；响应无堆栈、无 `java.` 包名、无 `.env`/口令内容 | P0 | security S01–S04 |
| TC-SEC-03 | 提示注入与 XSS：「忽略之前的指令…」、`<script>`/事件处理器载荷 | 仍按闸门/语料作答或正常拒答；响应回 JSON 不回 HTML；带 nosniff | P0 | security S05–S10 + acceptance D/F 组 |
| TC-SEC-04 | 日志与事件文件脱敏：发 >20 字原话后查 `server/data/events.jsonl` 与日志 | 只存 `hash#长度#前20字` 形态，20 字后原话不出现（`LOG_MESSAGE_MODE=hash`） | P0 | security S11 + db-check D03/D04 |
| TC-SEC-05 | 管理口令 fail-closed 三情形 + 误配置实例 | 见 TC-ADM-01/02 | P0 | security S15–S18、M01–M03 |
| TC-SEC-06 | 限流：同 IP 打满 30 次/分钟 → 429 + `retryAfterSec` + 统一信封；只读接口不受影响 | 429 可恢复（窗口滑过后成功）；`TRUST_FORWARDED_FOR=false` 时不因伪造 `X-Forwarded-For` 绕过 | P0 | security S20–S22 |
| TC-SEC-07 | SSE 边界：坏 JSON、事件序列、反代响应头、客户端断开 | 见 TC-SSE-01~05 | P0 | security G01–G07 |
| TC-SEC-08 | 任意 sessionId 可 GET/DELETE | **已收紧（2026-09-29）**：下发过令牌的会话，不带/带错令牌 → 404；从未下发令牌的老会话仍放行（向后兼容）。若产品改为多用户/公网，此用例转 P0 反向拦截 | P1 | security S19/S19a–d + `ChatWebContractTest` 4 条 |
| TC-SEC-09 | `uncovered_question`、`session_message` 存原文 | **预期存原文**——设计如此（运营补语料/会话恢复），与 chat_log 脱敏形成对比；DB 账号最小权限兜底 | P1 | db-check D07/D08（记录用例） |

### TC-DB 数据与隐私（映射 `tools/db-check.py`）

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-DB-01 | 查库表清单 | 五表齐全：`session`、`session_message`、`chat_log`、`feedback`、`uncovered_question` | P0 | db-check D01 |
| TC-DB-02 | 查应用账号 `SHOW GRANTS` | 仅 `SELECT, INSERT, UPDATE, DELETE, CREATE`，无 `DROP/ALTER/GRANT` | P0 | db-check D02 |
| TC-DB-03 | 问答后查 `chat_log.message_preview` | 形态为 `hash#长度#前20字`，不含 20 字后原话 | P0 | db-check D03/D04 |
| TC-DB-04 | 查 `chat_log.message_len`、`answer_preview` | `message_len` 记原长；`answer_preview` ≤80 字 | P1 | db-check D05/D06 |
| TC-DB-05 | 问答后查 `session`/`session_message` | 会话与消息落库，`seq` 有序，重启可恢复（与 TC-SES-09 联测） | P1 | db-check D07 + 手工 |
| TC-DB-06 | 闸门拦截后查 `uncovered_question` | 原文入列；命中问题不入列；超长问题截到列宽内 | P1 | db-check D08 + `UncoveredClipTest` |
| TC-DB-07 | feedback 表 | rating/question/comment 与提交一致，question 缺省时为服务端补的最后一问 | P1 | 手工 |
| TC-DB-08 | `chat_log` 统计字段 | `mode/provider/retrieval/no_hit/rewritten/latency_ms/tokens` 与 `/api/stats` 对得上；错误记入 `error` 与 `errors` 计数 | P1 | `db-check.py` D09a–k（增量对账）+ `AnalyticsSessionTest`（error 路径） |
| TC-DB-09 | 按 `docs/deployment.md` 做一次备份 → 换目录恢复 → 重启 | 会话/统计/反馈数据完整可用；`server/indexes/` 与 `knowledge/` 不依赖备份也能重建 | P2 | 手工（部署验证缺口） |

### TC-DGR 降级与容错（故障注入）

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-DGR-01 | 停掉 MySQL 后问答/刷新页面 | `storageAvailable=false`、`storage="mysql"` 仍如实上报；**问答照常**（内存态会话）、大屏不提示故障、运营视图可见；库恢复后自动回写 | P0 | `DegradedWriteTest` + 手工 |
| TC-DGR-02 | MySQL 启动阶段就不可用时起服务 | 服务仍起来，`/api/health` 200 且 `storageAvailable=false`；不因 DB 失败拒绝启动 | P1 | 手工 |
| TC-DGR-03 | LLM 上游超时/5xx（改错 `LLM_BASE_URL` 或断外网） | 非流式：500 `internal_error` 固定文案（不泄漏细节）；流式：`error` 帧；`chat_log` 留痕、`stats.errors` 计数；重试按 `LLM_MAX_RETRIES=2` 退避 | P0 | `OpenAiCompatChatModelTest` + 手工 + TC-SSE-07 |
| TC-DGR-04 | 知识库未就绪（`KNOWLEDGE_DIR` 空/不存在启动） | `ready=false`；问答 **fail-closed**（报错或拒答，绝不放飞乱答）；`knowledge/list` 如实反映空库 | P0 | 手工 + `RagBackendSnapshotTest` |
| TC-DGR-05 | embedding 构建失败（错误 `EMBED_*` 配置） | 退化为纯关键词检索；`retrieval.mode=keyword`、`degradedReason` 如实上报；问答仍可用 | P1 | `EmbeddingFallbackTest` + offline O06 |
| TC-DGR-06 | 查询期向量服务失败 | 单次查询失败即标记不健康（60s 冷却期只走关键词），期间 `retrieval` 不虚报 hybrid；冷却后一次成功即自愈 | P1 | `EmbeddingFallbackTest` |
| TC-DGR-07 | 向量索引文件损坏/版本不匹配（手改 `server/indexes/vectors.*.json`） | `tryLoad` 校验 fingerprint/provider/model/dims 失败 → 自动重建，不崩、不复用坏索引 | P1 | `RagBackendSnapshotTest` + 手工 |
| TC-DGR-08 | `KNOWLEDGE_WATCH=true` 下 reload 中途删文件 | 保留旧代继续服务（与 TC-KB-07 同口径） | P1 | 手工 |
| TC-DGR-09 | 语音上游不可用（`AUDIO_PROVIDER=mimo` 但断网） | 接口 502/503 可判定；前端朗读退浏览器合成、听写按钮给可理解提示，不卡死界面 | P1 | `MimoSpeechModelTest` + vitest `useSpeech` |
| TC-DGR-10 | 限流 429 后等待 `retryAfterSec` 再请求 | 恢复 200；窗口按滑动计算，不永久锁死 | P1 | security S20 + 手工 |
| TC-DGR-11 | 高并发下同一答案缓存写入 | LRU 上限 200（`ANSWER_CACHE_SIZE`）不失效崩溃；缓存满后旧条目淘汰、新条目可命中 | P2 | `HttpSupportTest`（key/容量）+ 手工 |
| TC-DGR-12 | 会话数超过 `MAX_SESSIONS=200` | 最旧会话被淘汰或拒绝新建，不 OOM、不影响已有问答 | P2 | `SessionStoreTest.超出上限时淘汰最旧会话且不影响新建` |

### TC-PERF 性能与并发

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-PERF-01 | 在域问题连续 20 次（非流式），记录 `latencyMs` | 建立延迟基线（mock 档应稳定在低位）；无渐进劣化 | P1 | 手工（记录基线） |
| TC-PERF-02 | 流式首帧（meta）到达时间 | 交互上无明显等待；首帧不被缓冲（结合 TC-SSE-02） | P1 | 手工 |
| TC-PERF-03 | 同题二次请求 | `cached=true` 且延迟显著低于首次 | P2 | smoke 11) 缓存行为组（延迟不高于首次；「显著」未量化） |
| TC-PERF-04 | 同一会话并发 6 发 | 无 5xx、无串答 | P1 | security B23 |
| TC-PERF-05 | 打满 30 次/分钟限流 | 第 31 次 429 且 `retryAfterSec` 合理；滑过后恢复 | P0 | security S20 |
| TC-PERF-06 | 前端连续快速发送（点击防抖） | 不产生重复气泡/并发流互相覆盖（generation 隔离） | P1 | vitest + 手工 |
| TC-PERF-07 | 长时间运行 2 小时以上 + 周期提问 | 无线程/内存持续增长、无 SSE 连接泄漏；`uptimeSec`/`chatTotal` 正常累计 | P2 | `tools/loadtest.py --duration 7200`（长跑人工触发；口径见 `docs/loadtesting.md`） |
| TC-PERF-08 | 200 会话/200 缓存上限内的批量混合操作 | 会话与缓存按上限淘汰，延迟不随数据量线性上涨 | P2 | 手工 |
| TC-PERF-09 | 并发混合：非流式 + SSE + 只读 + 中途断开 | 无 5xx/连接错误、无串话（sessionId 回显一致）、SSE 帧序 `meta→delta*→done`、只读接口不受聊天限流影响；429 单列不算失败 | P1 | `tools/loadtest.py`（CI 短跑 24+12；本地可加并发） |

### TC-DEP 部署与离线不变量

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-DEP-01 | 按 `docs/deployment.md`「一体机上线最小验收」顺序走一遍：起 MySQL → init.sql → 起 jar → health 四断言 → smoke → security → db-check → `offline-check --runtime` | 全绿才放开展厅使用（升级流程第 5 步同口径） | P0 | 手工清单 + CI 对应项 |
| TC-DEP-02 | `python tools/offline-check.py`（O01–O05） | 产物无联网 URL；后端出网入口只有三个白名单文件（LLM/embedding/MiMo 语音适配器）；依赖无联网 SDK/遥测 | P0 | offline + CI |
| TC-DEP-03 | `offline-check.py --runtime`（服务在跑） | 运行期自洽：`embeddingReady/mode/degradedReason` 不矛盾；mock 模式下无任何外呼 | P0 | offline `--runtime` |
| TC-DEP-04 | 阈值同步核查：改 `MIN_RELEVANCE_SCORE` 或 `MIN_VECTOR_SCORE` | `.env` / `application.yml` / `HybridRetriever` 默认常量 / CI workflow **四处同步**；`docs/.env.example` 注释同步 | P0 | 手工（改动时执行）+ calibrate 交叉 |
| TC-DEP-05 | push 到 GitHub | CI backend + frontend 全绿（mvn test → eval → calibrate → smoke → security 三实例 → db-check ∥ build → vitest → offline-check）；**只在 push 后生效，本地绿不能替代** | P0 | CI |
| TC-DEP-06 | Nginx/反代后面跑 smoke（`proxy_buffering off`、`X-Accel-Buffering` 透传） | SSE 不被缓冲、`meta` 首帧及时、长流不 502；限流键默认取 `remoteAddr`（`ClientIp.java`），同机反代下**未开 `TRUST_FORWARDED_FOR` 时全部客户端共用反代 IP 一个桶**（易整站 429，不是按各访客分桶）；要按访客各自地址分桶，需反代**先剥离**客户端自带的 `X-Forwarded-For` 再设 `TRUST_FORWARDED_FOR=true` | P1 | 手工（**原期望与实现不符，已按 `ClientIp` 改写**；`docs/archive/2026-09-24-code-review-handoff.md` 标注「真实反代未验证」——未验证，发布前必补） |
| TC-DEP-07 | 展厅现场网络：外网完全不通时启动 | mock 档（默认）全功能可用；配了云模型时按降级路径回落，页面无外网请求 | P1 | 手工 + offline O07 |
| TC-DEP-08 | `server/.env`、密钥、`server/indexes/`、`web/dist/` 不入库 | `git status` 干净、仓库历史无明文口令 | P0 | 手工核查 + offline O05 侧面 |

### TC-QUAL 内容质量（需真实模型）

| 编号 | 步骤 / 输入 | 预期结果 | 优先级 | 覆盖 |
| --- | --- | --- | --- | --- |
| TC-QUAL-01 | `python tools/acceptance.py`（A 组 fix，误拦/漏放/泛问，10 条） | 全部 `expect: answer` 且 `must` 命中、`never` 不出现 | P0 | acceptance A01–A10 |
| TC-QUAL-02 | B 组 corpus（新语料 5 条） | 新增资料确实可答 | P1 | acceptance B01–B05 |
| TC-QUAL-03 | C 组 fact（原文口径数字，10 条） | 数字与资料一致（不许「约等于」） | P0 | acceptance C01–C10 |
| TC-QUAL-04 | D 组 gate（域外拒答 7 条：笑话/天气/发票/大模型/写诗/股票/会议室） | 全部 `expect: refuse`（`noHit=true` 或命中拒答文案） | P0 | acceptance D01–D07 |
| TC-QUAL-05 | E 组 multi（同 session 多轮指代 5 条） | 指代消解后答对（对应 eval 的 `followUpRewrittenTop1Rate` 提升口径） | P0 | acceptance E01–E05 + eval |
| TC-QUAL-06 | F 组 nofab（不许编：价格、保修、竞品关系 3 条） | `never` 词零命中——资料没有的不编 | P0 | acceptance F01–F03 |

> acceptance 需真模型且不进 CI；发布前手工跑一轮。检索层门禁（top1/top3/gateBlockedCount/追问改写收益）由 TC-KB-09/10 的 eval 与 calibrate 在 CI 兜底，两层合起来才是「该答的答对、该拒的拒、检索找得到、模型不乱编」的完整口径。

## 3. 覆盖映射与缺口清单

### 3.1 用例组 ↔ 自动化载体

| 用例组 | 自动化载体 | 现状 |
| --- | --- | --- |
| TC-PRE / TC-CHAT / TC-SSE(部分) / TC-KB(契约部分) / TC-SYN / TC-META / TC-SPK(接口部分) | `tools/smoke.py` + CI | 已覆盖 |
| TC-SEC / TC-SSE(边界) / TC-SPK(边界) | `tools/security.py` + CI（三实例） | 已覆盖，编号见 `docs/security-testing.md` |
| TC-DB / TC-SEC(脱敏、原文明文) | `tools/db-check.py` + CI | 已覆盖 |
| TC-DEP(离线) | `tools/offline-check.py` + CI | 已覆盖 |
| TC-KB(检索质量) / TC-QUAL(检索侧) | `exec:java@eval`、`@calibrate` + CI | 已覆盖 |
| TC-QUAL(内容侧) | `tools/acceptance.py` | 已覆盖，**需真模型、不进 CI** |
| TC-CHAT/SSE/SES/FBK/DGR(单测面) | `mvn test`（JUnit） | 已覆盖 |
| TC-SSE(前端状态机) / TC-UI / TC-FBK(前端) / TC-SPK(前端) | `cd web && npm test`（Vitest，jsdom） | 已覆盖 |
| TC-CHAT(缓存) / TC-KB(reload+generation) / TC-SES(删除契约) / TC-FBK / TC-ADM(stats 字段与增量) | `tools/smoke.py` 11)–14) 组 + CI | 已覆盖（2026-09-29 补） |
| TC-DB(统计对账) | `tools/db-check.py` D09a–k + CI | 已覆盖（2026-09-29 补） |
| TC-SES(TTL) / TC-DGR(会话上限、轮次裁剪) | `SessionStoreTest`（JUnit，`mvn test`） | 已覆盖（2026-09-29 补） |
| TC-SSE(超时 UI) / TC-UI(展区竞态、health 降级、闲置复位、API 前缀、输入法组字) / TC-SES(前端令牌带回) | `App.spec` / `useChat.spec` / `apiUrl.spec`（vitest） | 已覆盖（2026-09-29 补） |
| **前后端连通性（真前端模块 → 真后端）** | `web/src/__live__/live-backend.itest.ts` + `web/vitest.live.config.ts`（17 条） | 需后端在跑；**不进 CI、不进默认 `npm test`**（文件名是 `.itest.ts` 且 tsconfig 排除） |
| TC-UI(真实点击与布局、真机语音) / TC-DGR(故障注入：LLM·库·语音断网) / TC-SES(重启恢复) / TC-DEP(反代、一体机开机自启·备份·断电重启) / TC-PERF(长跑) | 手工 | 仍需人工或到机器上做 |

### 3.2 缺口补齐记录（2026-09-29）

原来这 7 条标着「建议自动化」，现已全部落地，载体与口径如下（**判据一律以实际运行输出为准**）：

1. **缓存行为**（TC-CHAT-08/09、TC-PERF-03）→ `tools/smoke.py` 11) 组：同题二发 `cached=true`、答案一致、第二次延迟不高于首次；带 `sessionId` 的第二问 `cached=false`。
2. **会话契约**（TC-SES-05/06）→ smoke 12) 组：带令牌 `DELETE` 已存在会话 → `{ok:true}`，随后 `GET` 404；`DELETE` 不存在的会话 → 200 `{ok:false}`。**实测口径**：会话不存在时 `SessionStore.mayAccess()` 一律放行（为了不泄露「这个 id 是否存在」），所以「带错令牌删不存在的会话」同样是 200 `{ok:false}`；404 只出现在**会话存在但令牌不符**的场景。
3. **管理统计数值一致性**（TC-FBK-05、TC-ADM-04）→ smoke 13) 组：`/api/stats` 12 个字段逐项齐备 + 一次问答与一条反馈后的 `chatTotal`/`feedback.up` 增量。
4. **reload 与 generation**（TC-KB-06、TC-CHAT-10）→ smoke 14) 组：先喂热（`cached=true`）→ reload 字段齐全且 `generation` +1 → 同题再问 `cached=false`。聊天限流是 30 次/分钟，喂热步骤带 3 次退避重试；重试仍失败就记 SKIP，**不判过**。
5. **前端缺口**（TC-SSE-11、TC-UI-09/11/14/17）→ `App.spec`（180s 流超时、health 不可达降级、闲置复位）、`useChat.spec`（展区切换竞态）、`apiUrl.spec`（`VITE_API_BASE_URL` 前缀拼接）。闲置复位一条用假定时器真的推进 180s，并把 `IDLE_RESET_MS` 临时改成 1s 做变异验证——确认它会红。
6. **会话 TTL/上限**（TC-SES-04、TC-DGR-12）→ `SessionStoreTest`：假 mapper 注入一条已过 TTL 的会话（断言不可读）+ 一条刚活跃的（断言可读）；201 个会话断言淘汰最旧；10 轮断言只保留最近 6 轮。变异验证：改小 `TTL_MS`/`MAX_SESSIONS` 即红。
7. **统计口径对账**（TC-DB-08）→ `db-check.py` D09a–k：本次三条提问期间 `/api/stats` 的**增量**必须等于这三个会话在 `chat_log` 里的行数与汇总（`chatTotal`/`ragHits`/`noHit`/`rewritten`/`tokens.total`/`tokens.calls`/`errors`），另加逐行 `provider`/`retrieval`/`latency_ms` 合法性与「400 校验失败不计入 `chatTotal`」。**为什么只能比增量**：`/api/stats` 是启动时从 `chat_log` 恢复的累计计数，而本脚本会删掉自己写的探测行，累计值天然对不上。

仍留在手工侧的（不是本项目能自动化的）：真实点击/布局与真机语音、LLM·库·语音断网故障注入、重启恢复、反代与一体机现场（开机自启/备份/断电重启演练）、长跑与并发压测。

### 3.3 已知未决项与已定口径（写进用例预期，避免误判）

- **会话归属**（TC-SES-11、TC-SEC-08）：**已收紧（2026-09-29）**——问答响应下发 `sessionToken`；`GET/DELETE /api/sessions/{id}` **会话存在时**不带或不匹配一律 404（不承认该 id 有效，否则等于给枚举器）；**会话不存在时**按原语义回：`GET` 404、`DELETE` 200 `{ok:false}`。`ChatWebContractTest` 4 条单测 + `tools/security.py` S19/S19a–d + `tools/smoke.py` 12) 组 + `useChat.spec` 会话归属令牌组（前端）盯着。残留取舍（令牌持有者等价于会话所有者）见 `docs/security-testing.md`。
- **语义兜底「只重排还是可增候选」**（影响 TC-KB-02/13 对 `retrieval=hybrid` 的判定）：**已决策——允许语义新增候选，文档已对齐代码**（`docs/architecture.md`/`docs/knowledge.md` 已改写）；改动任一侧时仍要同步本文与 `docs/api.md`。
- **`MIN_VECTOR_SCORE=0.75` 实际关闭了向量兜底**：当前线上正常应见 `retrieval=keyword`；`hybrid` 只在真语义参与排序时出现。
- **文档数字**：活文档按实际运行输出统一（后端单测 **167**、前端单测 **144**、冒烟 **100**、安全 **91**（主实例，7 跳过；四实例 99/0/0）、库层 **19**、离线 **7**（1 跳过）、检索评测 **145**）；历史快照保留原数字，**一律以实际运行输出为准**。

## 4. 执行顺序与通过标准

### 4.1 日常回归（本地，服务在跑）

```bash
# 每行独立执行，均以仓库根目录为起点（不要顺着上一行的 cd 走）
cd server && ../tools/mvn -B test                       # 单测
cd web && npm test                                      # 前端单测
python tools/smoke.py                                   # 契约（串行）
python tools/security.py                                # 边界安全（串行，收尾自动等限流窗口）
python tools/db-check.py                                # 库层（勿与 security 并行）
cd web && npx vitest run --config vitest.live.config.ts  # 真机连通性（需 8787 在跑；真前端模块打真后端）
cd web && npm run build && cd .. && python tools/offline-check.py  # 先 build 再查产物
cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write --baseline=docs/eval/baseline-java.json"
cd server && ../tools/mvn -B test-compile exec:java@calibrate -Dexec.args="--gate-check --no-write"
```

### 4.2 发布验收（一体机/展厅）

1. push 后远端 CI 两条流水线全绿（TC-DEP-05）。
2. 按 `docs/deployment.md` 走 TC-DEP-01 清单全绿。
3. 真实模型下跑 `python tools/acceptance.py`，40 条全绿（TC-QUAL）。
4. 手工组全过：TC-UI、TC-DGR 故障注入、TC-SES TTL/重启、TC-DEP-06 反代。
5. 所有「已接受风险」用例（TC-SEC-08/09、TC-SES-11）确认仍与 `docs/security.md` 记录一致。
6. 任一 P0 失败 → 阻断发布；P1 失败 → 记录并评估；P2 可带记录遗留。
