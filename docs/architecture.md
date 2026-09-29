# 系统架构

展厅 AI 虚拟讲解问答。技术栈：后端 **Spring Boot 3.5.16**（`maven.compiler.release=21`，本机 JDK 25 只作环境）+ **MyBatis + MySQL**；前端 **Vue 3 + Vite 6 + TypeScript**（纯手写 CSS）。

2026-09 由 Node/Fastify + React **原地重写**而来：接口契约保持不变（见 `docs/api.md` 的「契约冻结」），旧代码只在 git 历史里。

## 1. 分层与包结构

后端源码根 `server/src/main/java/com/znwd/hostess/`：

| 包 | 职责 | 关键类 |
| --- | --- | --- |
| `config` | 装配与配置：属性绑定、`.env` 读取、启动流程、定时任务、知识服务门面 | `AppProperties`、`DotEnvPropertySource`、`AppConfig`、`CoreConfig`、`KnowledgeService` |
| `web` | HTTP 层：路由、鉴权、错误信封、请求 ID、CORS | `ChatController`、`StatusController`、`KnowledgeController`、`AdminController`、`SpeechController`、`GlobalExceptionHandler`、`AdminGuard`、`CorsAndIdFilter`、`RequestId`、`ApiException` |
| `rag` | 问答编排：改写 → 检索 → 闸门 → 生成 → 统计/缓存 | `ChatRunService`、`RagPipeline`、`QueryRewriter`、`RagAnswer`、`RagSource`、`RewriteResult` |
| `knowledge` | 检索本体：加载、分块、关键词打分、向量、融合、同义词、推荐问题 | `KnowledgeLoader`、`TextChunker`、`Retriever`、`HybridRetriever`、`VectorStore`、`Synonyms`、`Suggestions`、`ScoringOptions`、`RetrievalDiagnostics`、`RetrievalVerdict` |
| `embedding` | 向量提供方抽象：特征哈希兜底与 OpenAI 兼容接口 | `EmbeddingProvider`、`BagEmbeddingProvider`、`OpenAiCompatEmbeddingProvider`、`Vectors` |
| `llm` | 模型提供方抽象、提示词组装、用量统计 | `ChatModel`、`OpenAiCompatChatModel`、`MockChatModel`、`GroundedAnswer`、`LlmUsage`、`ChatMessage` |
| `audio` | 语音提供方抽象、WAV 解析与 MiMo TTS/ASR 适配 | `SpeechModel`、`DisabledSpeechModel`、`MimoSpeechModel`、`SpeechParser` |
| `http` | 无状态工具：限流、缓存、脱敏、JSONL 落盘、请求解析、CORS 策略、错误码 | `RateLimiter`、`LruCache`、`MessageLog`、`JsonlStore`、`RequestParser`、`ApiError`、`CorsPolicy` |
| `domain` | 落库实体 | `ChatLogEntry`、`FeedbackEntry`、`UncoveredEntry` |
| `repository` | MyBatis Mapper 与库可用性 | `ChatLogMapper`、`FeedbackMapper`、`UncoveredMapper`、`SessionMapper`、`HealthMapper`、`DatabaseStatus` |
| `session` | 内存会话窗口（多轮上下文） | `SessionStore` |
| `analytics` | 统计、反馈汇总、未覆盖清单（内存热路径 + DB 留痕） | `Analytics` |

资源与测试：`resources/{application.yml,schema.sql,openapi.json,META-INF/spring.factories}`；`db/init.sql`（建库建账号）；`eval/retrieval-cases.json`（评测用例）；`src/test/java/.../{knowledge,http,analytics,eval,cli}`（单测 + 三个 CLI 工具：`eval`、`calibrate`、`ingest`）。

前端源码根 `web/src/`：`App.vue`（页面状态与布局）、`api.ts`（契约、SSE 与语音请求）、`format.ts`（回答排版：粗体/列表/分段，不产出 HTML）、`composables/useChat.ts`（问答状态机）、`composables/useSpeech.ts`（服务端 TTS 优先、浏览器合成降级）、`composables/useDictation.ts`（录音、重采样与 WAV 编码）、`storage.ts`、`components/{SourcePanel,AdminPanel,KnowledgePanel,DiagnosticsPanel,StageDiagram,AvatarPortrait,AvatarFigure}.vue`（其中 `KnowledgePanel`/`DiagnosticsPanel`/`StageDiagram` 各有对应的 `.spec.ts` 单测）、`styles.css`。

## 2. 一次问答的时序

非流式与流式**共用同一条链路**（`ChatRunService`），缓存读写、会话写回、统计、日志只有一份实现——老版本只有非流式写缓存，导致「流式问过的问题再走非流式仍重算」，两个入口行为不一致最难查。

```
客户端
  │  POST /api/chat  或  /api/chat/stream
  ▼
CorsAndIdFilter → 生成 requestId(8位) 写请求属性 + x-request-id 头；按 CORS 策略回显 Origin，预检放行 GET/POST/PUT/DELETE/OPTIONS
  ▼
ChatController → 限流(RateLimiter，按 IP 滑动窗口) → 解析校验(RequestParser)
  ▼
ChatRunService
  ├─ 会话取历史(SessionStore，最近 6 轮 / 10 分钟 TTL)
  ├─ 追问改写(QueryRewriter)：指代/省略句与上一问合并（≤20 字、≤4 个携带词）
  ├─ 单轮且无历史 → 查答案缓存(LruCache，key 含模型 + 索引 generation + 问题)，命中即返回 cached=true
  ├─ 检索(HybridRetriever) → 命中 / 未命中（见第 3 节）
  ├─ 未命中 → 固定拒答（provider=gate，0 token，不调模型；NO_HIT_LLM=true 才让模型措辞）
  ├─ 命中 → RagPipeline 组装 system+资料+历史 → ChatModel 生成（流式逐字回吐）
  ├─ 写回会话、写缓存
  └─ Analytics.logChat → 内存计数（加锁）+ 异步外落库（锁外）；noHit 同时进未覆盖清单
  ▼
响应：非流式一次性 JSON；流式 SSE（meta → delta* → done，每 15s :ping 心跳）
```

要点：

- **闸门在生成之前**：未命中不调用模型，既省钱也避免「拿无关片段硬答」。
- **缓存与索引同代**：缓存 key 含 `generation`，`reload` 后旧代答案不会被复用。
- **统计不阻塞问答**：`Analytics` 内存操作加锁，DB 写移到锁外（库慢不该拖住大屏）。
- **管理鉴权默认 fail-closed**：`REQUIRE_ADMIN_TOKEN` 默认 `true`；未配口令时一律 401。回环豁免必须显式关闭该开关，并按连接对端 `remoteAddr` 判断，不能用同机反代下不可信的 `localAddr`。
- **就绪与存活分开看**：`/api/health` 的 HTTP 状态码仍可能是 200，但知识快照发布前 `ok=false`、`ready=false`；启动自动化必须读 JSON，依赖落库时再核 `storageAvailable`。
- **出网边界固定**：后端仅 `OpenAiCompatChatModel`、`OpenAiCompatEmbeddingProvider`、`MimoSpeechModel` 三个适配器可发起网络请求；`offline-check.py` O04 守住白名单，语音默认 `none` 不出网。

## 3. 检索流水线

```
knowledge/  ──KnowledgeLoader──▶  块（title/zone/tags/正文）
                    │                    │
                    │                    ├──TextChunker：以 # 标题为硬边界，段落打包到 500 字，
                    │                    │   超长段落按 500/80 滑窗切分；块 id = <相对路径>#<序号>
                    │                    ▼
                    │            Retriever（关键词路）
                    │              中文 bigram + IDF 加权 + 标题/展区标签/正文加权 +
                    │              词频增益封顶 + 长度归一；同义词扩展词降权（默认 0.45）
                    │                    │
                    └──VectorStore（向量路）│
                        bag（特征哈希兜底，semantic=false）或
                        openai_compat（真语义，semantic=true）
                        索引文件 indexes/vectors.<provider>.json，含内容指纹，变更自动重建
                                        ▼
                              HybridRetriever：RRF 融合 + 相关性闸门
```

- **命中判定**：关键词路最高分 ≥ `MIN_RELEVANCE_SCORE`（默认 6.3）→ 命中；否则看语义向量路（`semantic=true` 且余弦 ≥ `MIN_VECTOR_SCORE`）→ 兜底命中；两路都不达标才拒答。
- **语义向量不参与普通查询的排序**（2026-09-23 实测定的）：真 bge-m3 向量接上后让它参与 RRF 融合，137 条计分用例的 top1 从 1.0 掉到 0.9854（doc-08 / probe-45「运维方案能自动生成吗」被话题相邻的「项目背景与需求」顶掉）。规则因此收成：关键词路过了闸门就按关键词路排序（这条路上根本不查向量），语义向量只在**关键词没过闸门**时才检索、由它接管排序。
- **兜底路径上语义命中是「新增候选」**（已决策：文档对齐代码）：`HybridRetriever.rrfFuse` 会把向量独有的条目直接放进融合结果（该条目的 `keywordRank` 留空），不是只对关键词候选重排。线上问答（`RagPipeline`）与诊断（`/api/admin/diagnostics`）都走带闸门的调用（`applyGate=true`），新增候选还要余弦 ≥ `MIN_VECTOR_SCORE` 才放行；而该阈值当前标定为 `0.75` = 等效关闭（见下条），所以**生产实际走不到新增候选这一步**。
- **兜底口子当前是关着的**：标定显示域外最高余弦 0.6252（2026-09-29 复标，`near-1`「今年光伏补贴政策有什么变化？」），而补同义词后已没有「被误拦、需要兜底救回」的在域用例（0 条），区间无从成立——开口子必然先把域外问题放进来，所以 `MIN_VECTOR_SCORE=0.75`（等价于关闭兜底）。误拦靠补语料/补同义词解决。
- **非语义向量不参与融合**：`bag` 是哈希兜底、不是相似度，融进去只会打乱关键词路排序，而 `mode` 仍如实上报 `keyword`——上报与行为不一致最难排查。此时它只做诊断上报。
- **模式如实上报**：只有语义向量真的参与排序（兜底路径）才是 `hybrid`，否则 `keyword`（附 `degradedReason`）。语义路可用但没被用到的查询报 `keyword`，这是如实上报而不是降级。
- **语义路可降级**：embedding 走外部服务，它不通时**不阻塞启动、也不报错给访客**——构建失败退回仅关键词并记 `degradedReason`；查询期失败只影响本次检索、计数进 `queryFailures`/`lastQueryError` 并在 `/api/health` 的 `embeddingReady=false` 上体现，下一次成功自愈。
- **同义词**：内置 21 组在 `Synonyms`，可用 `knowledge/_meta/synonyms.tsv` 覆盖或走 `PUT /api/admin/synonyms` 在线替换；**查询期展开**，改完立即生效、无需重建索引。
- **诊断出口**：`RetrievalDiagnostics` + `RetrievalVerdict` 把「为什么被拦/命中」翻成一句人话，由 `/api/admin/diagnostics` 暴露。
- **换代原子性**：`HybridRetriever` 用 `volatile Snapshot(gen, keyword, ready)`，reload 时关键词快照与向量索引同代切换，检索中不会混代。

## 4. 并发与热路径

| 位置 | 做法 | 原因 |
| --- | --- | --- |
| 检索换代 | `volatile Snapshot` + `generation` 递增，`replace()` 串行 | reload 期间正在处理的问答不能读到半套索引 |
| 统计计数 | `Analytics` 内存部分 `synchronized`，**DB 写在锁外** | 库慢不能拖住所有问答（与「内存是热路径」的设计一致） |
| 答案缓存 | `LruCache`，只在**单轮且无历史**时命中 | 多轮上下文不同，复用会答错 |
| 限流 | 按 IP 滑动窗口（`RateLimiter`），键数上限 1000，命中时刷新插入序 | 防刷 + 防随机 IP 撑爆内存；活跃 IP 不被淘汰策略误删 |
| 定时清理 | `AppConfig.StartupRunner.housekeeping()` 每 10 分钟：清理过期会话、限流窗口、未覆盖清单裁剪 | 长时间运行不涨内存 |
| SSE | 专用 `sseExecutor` + 每 15s `:ping` 心跳；客户端断开按正常收尾 | 模型思考期长，避免中间设备判僵死；关屏不该刷错误日志 |
| 优雅停机 | `server.shutdown: graceful`，`timeout-per-shutdown-phase: 8s` | 展厅直接断电/关机时不丢正在处理的响应 |

## 5. 存储与降级

MySQL 表（`resources/schema.sql`，全部 `CREATE TABLE IF NOT EXISTS`）：

| 表 | 用途 | 要点 |
| --- | --- | --- |
| `session` | 会话元数据 | `id`（仅 `A-Za-z0-9._-`）、`created_at`、`last_active`（过期即清理） |
| `session_message` | 会话消息 | `(session_id, seq)` 用于恢复顺序 |
| `chat_log` | 问答日志 | `mode`、`provider`、`latency_ms`、`no_hit`、`retrieval`、`rewritten`、四个 token 字段；`message_preview` 默认是 hash 形态（不含明文） |
| `feedback` | 访客反馈 | `rating`（up/down）、`question` 摘要、`comment` |
| `uncovered_question` | 闸门拦下的原始提问 | 运营补资料的靶子 |

- **建表不在 `spring.sql.init`**：实测「连不上库」时 `continue-on-error` 不生效、会把整个 Spring 上下文打挂。改由 `DatabaseStatus.check()` 在库可达时用 `ResourceDatabasePopulator` 幂等执行 `schema.sql`（`spring.sql.init.mode: never`）。
- **库不可用不是故障**：服务照常讲解，只是不落库；`/api/health` 报 `storageAvailable=false`。展厅页面上不提示，状态只出现在运营视图（`?admin=1`）的「本机设置」里——大屏不给参观者看技术信息。Hikari 的 `initialization-fail-timeout: -1` + `connection-timeout: 3000` 保证启动不被库拖死。
- **面向展厅的语义**：数据表负责「重启不丢」与运营留痕，**内存才是热路径**。

## 6. 前端结构

| 文件 | 职责 |
| --- | --- |
| `App.vue` | 页面状态与布局：左 25% 讲解面板（上半虚拟形象、下半问答），右侧/下方另有讲解图 `StageDiagram`；闲置 3 分钟自动回到欢迎态；`avatarState`（等首字=thinking / 出字=speaking / 其余=idle） |
| `api.ts` | 契约类型与调用；SSE 用 `fetch` 流式读取 + 逐帧解析（`EventSource` 只能 GET，提问要放 body）；跨 chunk 半帧重组；封装 TTS/ASR 请求；中文/TS 类型与后端字段一一对应 |
| `composables/useChat.ts` | 问答状态机：发送、流式增量、失败不抹掉已收到的半句、来源、推荐问题、反馈 |
| `composables/useSpeech.ts` | 语音播报：服务端 MiMo TTS 优先，失败当场退回浏览器合成；只读回答、流式结束整段读、长文按句切片、开关落 localStorage |
| `composables/useDictation.ts` | 语音提问：采集 16kHz 单声道 PCM、重采样、拼 WAV，再调用服务端 ASR |
| `storage.ts` | 浏览器存储的安全读写封装 |
| `format.ts` | 回答排版：`**粗体**`→加粗片段、`1.`/`·` 列表→悬挂缩进、空行分段；只产出结构交给模板渲染，模型输出里的尖括号只是文字 |
| `components/AvatarPortrait.vue` | 虚拟形象：立绘优先（`public/avatar-guide.png`），`AvatarFigure.vue`（手写 SVG）兜底；外部只吃 `state` 属性，换 3D/Live2D 只改内部 |
| `components/SourcePanel.vue` | 来源折叠面板（「查看来源（N）」） |
| `components/AdminPanel.vue` | 运营抽屉：统计、未覆盖问题、反馈 CSV；并挂载 `KnowledgePanel`（知识清单、reload、同义词热更新）与 `DiagnosticsPanel`（检索诊断） |

布局约束：浅色极简、白底无边框卡片、大留白；不引 UI 框架、不用 emoji。

## 7. 扩展点

| 要改的东西 | 落点 |
| --- | --- |
| 换 LLM | `LLM_PROVIDER=openai_compat` + `LLM_BASE_URL/API_KEY/MODEL`（`.env`）；新增提供方实现 `ChatModel` |
| 换向量模型 | `EMBED_PROVIDER=openai_compat` + `EMBED_*`，然后 `POST /api/knowledge/reload` 重建索引 |
| 配服务端语音 | `AUDIO_PROVIDER=mimo` + `AUDIO_*`；留空的 base URL/key 回落 `LLM_*`，默认 `none` 不出网 |
| 调检索打分 | `ScoringOptions` 的默认值；**改完必须重跑标定**（`mvn exec:java@calibrate --grid`） |
| 调闸门阈值 | 四处同步：`.env`、`application.yml`、`HybridRetriever.DEFAULT_MIN_KEYWORD_SCORE`、CI 环境变量；先标定再改 |
| 调语义兜底阈值 | 四处同步：`MIN_VECTOR_SCORE`、`application.yml`、`HybridRetriever.DEFAULT_MIN_VECTOR_SCORE`、CI；当前均为 `0.75`，改后跑 `calibrate --gate-check` |
| 改检索行为 | 跑 `eval --no-write --baseline=docs/eval/baseline-java.json`；CI 逐例守住 top1 路径、指标与漏答数 |
| 补同义词 | `PUT /api/admin/synonyms`（在线）或 `knowledge/_meta/synonyms.tsv`（落盘）；改完重跑标定与评测 |
| 换虚拟形象 | 只动 `AvatarPortrait.vue` 内部（外部只吃 `state`） |
| 加接口 | `server/src/main/java/com/znwd/hostess/web/` 下新增/扩展 Controller，异常一律抛 `ApiException`（统一信封）；同步更新 `resources/openapi.json` 与 `tools/smoke.py` |
| 加表 | `resources/schema.sql` + `domain/` 记录 + `repository/` mapper |
| 多屏/后台 | 先把 `/api/health`、`/api/stats` 接出去；已带 `spring-boot-starter-actuator`（只暴露 `health,info`），要 Prometheus 指标再接 `micrometer-registry-prometheus` |

## 8. 刻意取舍（不是遗漏）

- **用 MySQL 而不是只落 JSONL/SQLite**：为后续展厅后台/多屏共用同一份数据铺路；热路径仍在内存。
- **日志默认脱敏**：只落 hash + 20 字前缀（`MessageLog.fields(msg, false)`），`previewMode` 才落 80 字预览——访客原话不该整段落盘。
- **拒答文案固定**：闸门拦截时返回固定文本、0 token；实测让模型生成拒答要 780 tokens 且多等 4.7s，纯浪费。
- **测试用合成语料**：闸门行为要可复现，不受展厅资料改动影响；合成语料用**自己的固定阈值**，不跟生产阈值走。
- **`/api/suggestions` 返回字符串数组**：与旧契约一致，前端按字符串渲染；曾因按对象取字段导致大屏空白按钮。

## 9. 关键常量

| 常量 | 值 | 位置 |
| --- | --- | --- |
| 闸门阈值 `minKeywordScore` | 6.3（真实问句口径下域外零漏放的最优覆盖点） | `application.yml` / `HybridRetriever` |
| 语义向量阈值 `minVectorScore` | 0.75（= 关闭兜底：域外最高余弦 0.6252 高于待救用例 0 条，区间不成立） | 同上 |
| 管理口令默认值 `requireAdminToken` | `true`（未配 `ADMIN_TOKEN` 时 fail-closed；回环豁免必须显式关闭） | `application.yml` / `AppProperties` |
| 检索 topK | 4 | `RagPipeline.DEFAULT_TOP_K` |
| 拼上下文的历史条数 | 12 | `RagPipeline.MAX_HISTORY_MESSAGES` |
| 分块上限 / 重叠 | 500 / 80 字符 | `TextChunker` |
| 会话窗口 | 6 轮 / 10 分钟 / 最多 200 会话 | `SessionStore` |
| 内存日志 / 反馈窗口 | 500 / 500 | `Analytics` |
| 限流 | 30 次/分钟/IP，键上限 1000 | `CHAT_RATE_PER_MIN` / `RateLimiter` |
| 答案缓存 | 200 条 | `ANSWER_CACHE_SIZE` |
| LLM 超时 | 90s（流式 180s），重试 2 次退避 1s/2s | `application.yml` |
| SSE 心跳 | 15 秒 | `ChatController` |
| 闲置回欢迎态 | 3 分钟 | `web/src/App.vue` |
