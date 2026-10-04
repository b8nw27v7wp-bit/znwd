# 优化与新增清单（重构后）

记录重构后代码审查的结论：已修的、待做的。待做项按"展厅实际影响 × 成本"排序。

## 已修（第一轮，均有验证）

| 问题 | 影响 | 修法 |
| --- | --- | --- |
| `ChatLogMapper.insert` 用了 `#{promptTokens}`，而 `ChatLogEntry` 只有 `usage` 对象 | **每次问答的 chat_log 落库都在静默失败**（被 catch 成 warn），统计重启即清零 | 改成 `#{usage.promptTokens}` 等嵌套取值 |
| `FeedbackMapper.insert` 带 `@Options(useGeneratedKeys, keyProperty="id")`，record 无 id | 插入成功但抛异常、日志刷 warn | 去掉 `@Options` |
| `Analytics.logChat` 从不写 `uncovered_question` | 未覆盖问题清单只活在内存里，运营重启后拿不到补资料靶子 | 落库（单独一张表，保留期与内存窗口一致） |
| `Analytics.logChat/logFeedback` 持锁做数据库 I/O | 库慢会拖住所有问答请求（与"内存是热路径"的设计相矛盾） | 内存操作加锁、DB 写移到锁外 |
| 请求体非法 JSON 时回 `message is required` | `/api/feedback` 收到坏 body 会把排查方向指错 | 拆成独立 handler，回"请求体不是合法 JSON 对象" |
| `AdminGuard` 用 `String.equals` 比对口令 | 理论上可逐字节试探 | 改 `MessageDigest.isEqual` 常量时间比较 |
| `RateLimiter.evictExpired()` 无人调用 | 长时间运行后按 IP 的历史窗口不回收 | 挂到已有的定时清理任务上 |
| `FeedbackMapper.count/countUp` 无调用方 | 死代码 | 删除 |
| pom.xml 注释里出现 `--` | XML 注释非法，**所有 maven 命令直接失败** | 改注释文案 |
| 前端无闲置处理 | 大屏前换人后上一个参观者的对话还挂在屏幕上 | 闲置 3 分钟自动回到欢迎态 |
| `vite.config.ts` 用 `process.env` 但没装类型 | `npm run build` 类型检查失败 | 加 `@types/node` 并写进 tsconfig types |

## 已做（第二轮：工程资产与运维口子）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **标定工具**（原 `scripts/calibrate.ts` + `tune-scoring.mjs`） | `mvn -q test-compile exec:java@calibrate`。输出：在域/域外分数对照表、闸门区间建议、参数网格（`--grid`）、报告落 `docs/eval/calibration-*.json`；区间不成立时退出码 2，可当 CI 失败条件 | 实测：在域最低 **8.933** / 域外最高 **3.654** → 建议阈值 **6.3**（与生产 `.env` 一致，余量 0.58）；网格 **36 组没有一组超过当前默认**，确认 `ScoringOptions` 默认值仍是最优 |
| **检索诊断接口** `/api/admin/diagnostics?q=&topK=` | 走线上同一套索引与阈值，回 `gated/reason/两路分数/候选数/阈值/距阈值距离` + 一句人话结论（`RetrievalVerdict`），命中项带分数与命中词 | 实测：在域"叶片检测要停机吗"→ keyword 24.33 / 余量 18.03；域外"写一首夏天的诗"→ gated、距阈值 4.08 |
| **同义词表热更新** `GET/PUT /api/admin/synonyms` | 内置表 + `knowledge/_meta/synonyms.tsv` 覆盖；`PUT` 立即生效（查询期展开，无需重建索引）、可选落盘；`knowledge` reload 时一并重载 TSV | 冒烟探针实测：加一个 `ZWPROBE→叶片` 的临时映射后，探针问题的关键词分立刻从 0 抬起，还原后回到原值 |
| **评测/标定共用** `EvalSupport` | 用例解析、命中判定、域外样本、报告落盘只留一份，防"评测一套口径、标定另一套口径" | 改完重跑评测：top1 0.9333 / top3 0.9667 / 漏答 0，与改动前逐项一致 |
| 契约与元数据 | `openapi.json` 补两个新路径 + `Diagnostics`/`Synonyms` schema，版本 1.2.0（`/api/health` 同步）；`/api/knowledge/list` 增加同义词摘要 | `python tools/smoke.py` **56/56**（原 32 项，新增 24 项覆盖诊断与热更新） |
| 工具类输出编码 | Windows 控制台默认 GBK，评测/标定报告中文花屏 | 两个工具入口统一按 UTF-8 输出 |

### 标定暴露的两个事实（供后续决策）

- **召回天花板（用例集 v3 起已无漏例）**：旧用例集下 `wind-06`、`svc-05` 在任何参数组合下都进不了 top1；换成公司自有材料、把访客问句做成小节标题、并把只讲风机的旧资料删掉后，42 条计分用例全部 top1 命中。要提升只能补语料或补同义词，调参数无用。
- **默认阈值演进**：`3.8`（23 块语料中点）→ `6.3`（2026-09-20，8 篇演示资料入库后）→ `8.1`（2026-09-21，修掉跨标点 bigram 与「话题枢纽式同义词」后）→ **`6.3`**（2026-09-22，语料换成三份公司材料并按真实访客问句重标；区间不成立，取域外零漏放的最优覆盖点）。四处同步：`server/.env`、`application.yml` 的 `MIN_RELEVANCE_SCORE` 默认值、`HybridRetriever.DEFAULT_MIN_KEYWORD_SCORE`、CI workflow。合成语料单测仍固定用自己的 3.8——它不该跟着生产阈值走，否则每次重新标定都会让闸门行为测试无辜变红。

## 已修（第九轮：待办与风险收口）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **前端组件测试补全** | 新增 `components/AdminPanel.spec.ts`（4 条：三接口渲染统计与待补资料、口令只进 `sessionStorage` 并作为 `authorization` 头带上、401 给一句人话且不渲染半张表、接口挂掉把原因显示出来）；`App.spec.ts` 新增「对话主流程」4 条（点「有帮助」把反馈连同上一轮问题上报、连续追问复用同一会话、点推荐问题直接提问、空白输入与 Shift+Enter 都不发请求）；`components/StageDiagram.spec.ts` 5 条（三块结构、关键节点、未命中支路、技术栈与实测数据各 6 项、**图上数字与仓库口径一致**）；`components/SourcePanel.spec.ts` 5 条（空态、卡片渲染、分数只显示有值的部分、缺展区回落、片段里的尖括号当文字） | 前端单测 37 → **55 项全绿**；`npm run build`（vue-tsc + vite）通过 |
| **来源面板去掉无关资料** | `RagPipeline.toSources` 按关键词分量级过滤（`SOURCE_KEEP_RATIO = 0.5`）：低于本次最高分一半的块不展示。实测「多久能回本」3 → 1 条、「数据涉及居民隐私」2 → 1 条，多来源问题照旧保留 | `RagPipelineTest` 6 条；后端单测 64 → **70 项** |
| **请求体大小上限** | 新增 `web/RequestSizeLimitFilter`（`@Order(2)`）：写请求 `Content-Length > 64KB` 直接 413 + 统一错误信封；**没有 `Content-Length` 的写请求（分块传输）按超限处理**——本服务没有上传接口，放行就是个绕过口子。`ApiError` 增加 `payload_too_large` | 新增 4 条单测；真机实测：65 字节 200 / 70063 字节 413（带 requestId）/ 60063 字节 200 / 分块传输 413；冒烟 56/56 不受影响 |
| **闸门余量挂进 CI** | `Calibrate` 增加 `--gate-check`：域外最高分（排序分口径，与 `HybridRetriever` 判闸门同判据）不得越过生效阈值，越线退出码 3；CI 在检索评测之后加一步。**刻意不用「区间是否成立」当判据**——当前语料下区间本就不成立，拿它当失败条件只会让 CI 长期红着、没人看 | 实测：阈值 6.3 时守住退 0（余量 0.081）；故意 `MIN_RELEVANCE_SCORE=6.0` 时越线退 3。单测 60 → **64 项** |
| 文档同步 | `docs/development.md`（单测/前端项数、`--gate-check`）、`docs/eval.md`（标定参数与退出码、单测项数）、`docs/api.md`（413 错误码）、`README.md`（单测项数） | — |

## 已完成（第十二轮：交付前收口，2026-09-29）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **零断言探针 → 正式契约用例** | 删掉 `ProbeWebTest`（只 `println`、不断言，且漏 mock 新加的 `feedbackRateLimiter`，整类上下文加载失败＝本地单测长期 5 条 ERROR），换成 `ChatWebContractTest` 13 条 | `mvn test` **157 项**（149 里的 5 红消失，净增 8 条有效用例）；覆盖错误信封 404/415/405、两类 400 文案差异、SSE 帧序与 `done` 带令牌、会话归属、反馈独立桶 |
| **`tools/security.py` 按新契约改写 S19** | 旧断言「知道 `sessionId` 就能删（200）」在会话令牌落地后必然红；改成 5 条：令牌下发 / 无令牌删 404 / 错令牌删 404 / 持令牌读 200 / 持令牌删 200 | 四实例实测 **98 通过 / 0 失败 / 1 跳过**（S21 限流窗口时序抖动） |
| **文档口径按实际输出统一** | 单测 123→157、前端 104→134、语料 215→**219 块/17 篇**、域外最高余弦 0.6826→**0.6252**、闸门余量→**0.130**、P1 会话所有权状态、`docs/eval.md` 新增第七版标定结论 | 全仓 grep 复核；`README.md`、`docs/*.md`、`server/.env.example` 同步 |
| **`.env.example` 补漏** | 补上 `FEEDBACK_RATE_PER_MIN`（application.yml 有、模板缺）；阈值注释里的旧语料规模改成 219 块口径 | 与 `application.yml` 逐键对齐 |

> 本轮**没有改任何业务逻辑**：改的是测试载体（探针→契约用例）、检查脚本的期望（S19）与文档口径。
> 唯一的行为性改动是上一批（会话令牌 / 反馈独立桶 / 话术外置 / 运营面板），本轮把它们跑成了可交付证据。

## 已完成（第十三轮：三路代码审查收口 P0/P1/P2，2026-10-04）

三路并行审查（后端主链路 / 前端工程资产 / 安全运维）发现问题，按文件不重叠分工作流修复：

| 优先级 | 项 | 修法与验证 |
| --- | --- | --- |
| P0 | **SSE 中断静默丢账** | 客户端中途断开时部分回答写回会话、`chat_log` 落 `error=client_gone`、半截不进缓存；`ClientGoneException` 移入 `http` 包（rag 不依赖 web）。新增 ChatRunServiceStreamAbortTest + 契约层两条（error 路径对照） |
| P0 | **会话令牌可无凭证换取** | 令牌创建即铸造、`issueTokenOnce` 至多交付一次；`mayAccess` 收掉「无令牌即放行」后门；restore 的老会话标为已交付（历史对 API 关闭等 TTL）。仅凭 localStorage 的 sessionId 换不到上一位访客的令牌 |
| P0 | **闲置计时器一次性失效** | `bumpActivity` 回调落空（streaming/resetting）时无条件重新武装；挂死流报错后仍会自动回欢迎态。红绿验证过 |
| P1 | **SSE 断流活性检测** | 前端 45s inactivity（任何字节含 `:ping` 刷新）替代干等 180s 总超时；零 delta 失败自动重问一次（有 delta 不重问、总超时不重问） |
| P1 | **热路径重复重活** | 向量-语料对齐结论改换代时算一次随 Snapshot 走（此前每问/每次改写/health 轮询都对全语料拼串+SHA）；检索分词建索引期预算。`HotPathCacheTest` 比值型守卫（退化实现必越线）。QueryRewriter 预查复用经评估跳过（eval 风险大于收益） |
| P1 | **SessionStore 锁内 I/O** | `restore()` 锁外查库、短锁整体合并；新增首条并发用例（restore 期间读写不阻塞） |
| P1 | **死代码与重复** | 删零调用方的 `RagPipeline.stream`/`StreamOutcome`；SOURCE_KEEP_RATIO 与 rewrite/usage 拼装收敛（响应 JSON 字段名未变） |
| P1 | **deploy 脚本假成功** | start 退出码非零即 Die、健康超时 Warn→Die、包内 jar 版本与 `health.version` 三态比对 |
| P2 | **30x 密钥外带面** | 三出网适配器 `followRedirects=NEVER`、3xx 报明确错误且不可重试；302 用例带目标命中计数，变异验证 |
| P2 | **DotEnv 行内 ` #` 截断** | 值原样保留（example 注释均独占一行）；`DotEnvValueTest` 6 条，变异验证 |
| P2 | **SSE 异步线程 requestId 丢失** | 进 executor 前捕获，error 帧 == `x-request-id` 头有契约用例；ProbeBeans 改真线程才能复现该 bug |
| P2 | **api.ts 1011 行五职责** | 拆 `api/{types,http,stream,admin,speech,index}.ts`，48 导出逐一比对无缺漏、消费方 import 零改动 |
| P2 | **无 lint/coverage 门禁** | ESLint（真问题规则集，0 error/0 warn）+ v8 coverage 阈值 86.5/73.5/88.5/90（实测 88.14/75.08/90.32/91.67 留 ~2 点余量），CI frontend job 两步都接 |
| P2 | **三个测试缺口** | 真·断流保留半句（不重问）、SSE `event:error` 帧、ASR `stop()` 三路回调 |
| 文档 | **4 处口径漂移** | actuator 实配 `health,info,prometheus`；交付包不含 `.env`；schtasks `ONSTART`/`znwd-hostess`；反代限流共桶（TC-DEP-06 改写）。另 `web/src/api.ts` 路径在活文档 5 处更新 |

验证口径：后端 **198** / 前端 **164** / lint 0/0 / coverage 过阈值 / 检索评测 145 例 top1 不一致 0 / build 通过。
详情见 `CHANGELOG.md` 2026-10-04 条目。**已知取舍**（审查确认、刻意不改）：令牌「已交付却无人持有」窗口 fail-closed；写帧异常统一归类 client_gone（与 G07 口径一致）；restore 先整库读完再合并（仅 DB 读放大）。

## 待做（更新于 2026-10-04）

1. ~~**（可选）指标暴露**~~ **已完成（本待做项关闭）**：`micrometer-registry-prometheus` 已接入，`management.endpoints.web.exposure.include` 暴露 `health,info,prometheus`；`/actuator/prometheus` **无鉴权**，默认只监听 `127.0.0.1` 同机抓取，跨机须反代限源（否则从 include 移除 `prometheus`，见 `docs/architecture.md`、`docs/deployment.md`）。单机展厅当前 `/api/health` + `/api/stats` 够用。
2. ~~近域域外漏放~~ **已处理（第十一轮）**：`near-3`「扫地机器人多少钱？」/ `near-4`「这个机器人能送外卖吗？」词面命中的
   就是「机器 / 器人」两个高频 bigram（实测 8.996 / 8.994），**抬阈值会连带误拦真实问句**，所以没抬；改成让这类问法
   **答得对**：`01_光伏清洁机器人/常见问题.md` 新增一节「你们做扫地机器人吗」，答案用原文产品口径 + 明说
   「资料中没有家用扫地机器人等其他品类产品的说明，也没有任何产品报价」。闸门仍会放行这类问题，但现在答的是有依据的话，
   不是模型自由发挥（此前实测会自己补一句「建议联系销售部门」——资料里没有这句）。
3. **（可选）语义兜底口子**：`MIN_VECTOR_SCORE=0.75` 等于关着。等补语料把误拦降到 0 之后重跑 `calibrate`，
   看「待救在域最低余弦」是否终于高过「域外最高余弦」（2026-09-29 复标：待救 0 条、余弦 0.0000 < 域外最高 **0.6252**），成立才谈开口子。

## 已完成（第十一轮：补语料 + 误拦/漏放收口）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **误拦清零（2 → 0）** | 真实访客问句「有客户了吗」「融资了吗」词面太短（原话分 4.90 / 5.90，阈值 6.3），补同义词两条：`客户 → 客户数量/客户情况/服务客户/客户案例`、`融资 → 融资阶段/融资需求/总融资额/投资方`（只收同域复合词，不收话题联想词） | 评测 `gateBlockedCount` **2 → 0**、`gatedTop1Rate` 0.9854 → **1.0**；top1 仍 137/137 |
| **漏放改成答得对** | 见上「待做 2」：新增「你们做扫地机器人吗」小节，答案 = 原文产品口径 + 资料范围声明 | 实测两问均给出有依据的回答，不再出现资料外语术 |
| **泛问法覆盖** | 「项目有什么社会效益 / 对社会有什么好处 / 有什么社会价值 / 环境效益怎样 / 项目意义是什么 / 对环保有什么贡献」这类词面与语料不重叠的问法：补 `效益/社会/好处/意义/环保` 五条同义词 + 把自然问法写进 FAQ 小节标题 | 六个问法实测全部过闸门（诊断 6.4~15.2） |
| **补 6 段未覆盖原文** | 宁波大赛 4 段运维痛点 + 1 段引领目标 → `03_项目与团队/项目背景与需求.md`；延长设备寿命 / 推动绿色能源 / 推广意义 / 综述 4 段 → `03_项目与团队/应用成效与案例.md`；申报书「技术创新之处」3 条 + 模块化 + 应用展望 → `02_光伏医生运维系统/系统总览.md`；数据来源说明 → `02_光伏医生运维系统/数据基础与数据治理.md`。**全部逐字取自原文** | 溯源复核：全语料 757 句可判定、无 10 字锚点 148 句（141 + 新增 6 段的锚点全部命中 + 1 句资料范围声明），**含原文没有的数字的句子 0 条** |
| **标定工具口径修正** | 「被关键词闸门误拦」的判据从 `keywordGateScore`（只算原话）改成 `rankingBest`（排序分）——与闸门实际比的那个数一致，否则会出现「报 2 条误拦、线上其实 0 条」 | 改后输出「误拦 0 条」，与评测一致 |
| 规模变化 | 语料 209 → **215 块**；内置同义词 23 → **30 条**（`SynonymsTest` 的改动检测断言同步） | 单测 83/83、冒烟 56/56、`calibrate --gate-check` 退出 0（域外最高 6.110 < 6.3，余量 0.190） |

## 已完成（第十轮：语义向量接上云端并标定）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **embedding 换云端** | `EMBED_PROVIDER=openai_compat` + 硅基流动 `https://api.siliconflow.cn/v1` + `BAAI/bge-m3`（1024 维、L2 归一、定价页标免费）。MiMo 自己没有 embeddings 接口（实测 `/v1/embeddings` 对任何模型名 404），所以只能另接一家或本机跑。索引按 provider 分文件，换 provider 自然新建 `vectors.openai_compat.json`（209 块 / 1024 维，重建 8 秒） | 实测单条 200、1024 维；批量 33 条也没报上限（仍把 `EMBED_BATCH_SIZE=32` 做成可配，各家上限不同） |
| **语义路只做兜底与诊断，不参与普通查询排序** | 先按「向量参与 RRF 融合」实现，评测立刻掉分：top1 1.0 → 0.9854（`doc-08`/`probe-45`「运维方案能自动生成吗」被话题相邻的「项目背景与需求」顶掉）。收成「关键词过了闸门就按关键词排序；语义向量只在关键词没过闸门、余弦达标时接管排序，且只对关键词候选重排、不新增候选」 | 评测回到 **137/137 top1 1.0**、top3 1.0、闸门误拦 2 条（与旧基线逐例一致）；新增 3 条单测钉住这条边界（`SemanticRetrievalTest`） |
| **兜底阈值按余弦重标：0.35 → 0.75** | 新增「近域域外样本」（`EvalSupport.OUT_OF_DOMAIN_NEAR`：词面与语料高度重叠、余弦天然偏高的问题），标定输出域外最高余弦与「待救在域最低余弦」。实测域外最高 **0.6826** > 待救 **0.6389**，区间不成立 → 取「域外不越线」的点 = 关闭兜底 | `calibrate --gate-check` 新增一条线：域外最高余弦 ≥ 生效阈值 → 退出码 4（实测 0.6826 < 0.75 守住退 0）。四处同步：`.env` / `application.yml` / `HybridRetriever.DEFAULT_MIN_VECTOR_SCORE` / CI |
| **语义路可降级，不拖垮展板** | embedding 走外网后：构建失败不再让启动失败，而是记 `degradedReason` 退回仅关键词；查询期失败只影响本次检索、计数进 `queryFailures`/`lastQueryError`，`semantic` 转 false、下一次成功自愈；`/api/health` 加 `embeddingReady` 一眼可见 | 真机实测：把 `EMBED_BASE_URL` 指到死端口起服务 → 启动正常（索引从本地文件加载）、问答照常答对、health 报 `embeddingReady=false` + 原因；新增 3 条单测（`EmbeddingFallbackTest`）。`offline-check.py` 的判据改成「除大模型与 embedding 外一律本地 + 这两个依赖不可用时仍能答」 |
| 契约与文档 | `/api/health` 加 `embeddingReady`；`retrieval.vector` 加 `degradedReason`/`queryFailures`/`lastQueryError`；版本 `1.2.0` → `1.3.0`；`EMBED_BATCH_SIZE` 可配 | 冒烟 **56/56**、离线检查 7/7、单测 **83 项**全绿；文档同步 `architecture/eval/api/deployment/knowledge/development/README/.env.example` |

> 本表是**历史快照**（数字与结论保留当时原貌）。其中「只对关键词候选重排、不新增候选」已被后续产品决策取代：
> 现行契约是**允许语义新增候选**（文档对齐代码），见 `docs/architecture.md` §3、`docs/knowledge.md` §5；
> 「`MIN_VECTOR_SCORE=0.75` 等效关闭兜底」的结论不变。本文件数字与最新活文档（单测 167、前端 144、冒烟 100）不一致时，以活文档为准。

## 已完成（第三轮：文档与配置换成新栈）

| 项 | 内容 |
| --- | --- |
| 文档全部重写 | `README.md`、`docs/{README,api,architecture,development,deployment,eval,knowledge}.md` 从 Node/Fastify + React 时代改成 Spring Boot + Vue 3 的写法（命令、路径、环境变量、接口字段逐条对着代码核对）；Node 时代的审查文档留在 `docs/archive/` |
| `server/.env.example` 修正 | 去掉新栈里已不存在的 `PERSIST_STATE`/`PERSIST_INTERVAL_SEC`（状态已落 MySQL）、补上原先完全缺失的 `DB_*` 全组、标定命令改成 `mvn exec:java@calibrate`、默认阈值改 6.3；键名以 `application.yml` 为准 |
| 阈值三处同步 | `application.yml` 默认值、`HybridRetriever.DEFAULT_MIN_KEYWORD_SCORE`、CI 环境变量都改为 6.3 |

## 已修（第四轮：配置接线 + 文档收尾）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **`NODE_ENV` 绑定失效 → 生产强制管理口令的安全规则从未生效** | `AppProperties.nodeEnv` 是 record 字段，relaxed binding 只认键 `znwd.node-env`，而 application.yml 里没有这个键；`.env` / 系统环境里的 `NODE_ENV` 是另一条独立键，绑不上。于是「生产（`NODE_ENV=production`）未配 `ADMIN_TOKEN` 的管理接口必须 401」这条规则静默失效——编译、启动、其余单测全都不报错 | application.yml 增加 `node-env: ${NODE_ENV:}`。实测两个场景：不设 `NODE_ENV` → `GET /api/stats` **200**（开发放行）；`NODE_ENV=production` 且未配口令 → **401** |
| 配置接线守卫测试 | 新增 `config/AppPropertiesBindingTest`：反射遍历 `AppProperties` 每个 record 字段，断言 application.yml 的 `znwd` 段里有对应 kebab-case 键；另有一条断言 `node-env` 必须显式绑 `${NODE_ENV:}` | 把 `node-env` 行临时删掉 → 该测试 **2 项失败**（确实拦得住这个 bug 类），恢复后通过 |
| 管理口令规则测试 | `HttpSupportTest` 补一条：`NODE_ENV` ∈ production/prod/staging（含大写）且未配口令必须 401；development/test/空 放行 | 单测 30 → **33 项全绿** |
| 文档收尾 | 根 `plan.md`（Node 时代交接文档）按仓库约定归档为 `docs/archive/old-node-plan.md` 并加归档说明；`knowledge/_meta/demo-docs.md` 里残留的 `npm run calibrate` / `npm run eval:retrieval` 换成新栈命令（并补 reload 一步）；README 与 docs 里的单测数 30 → 33；archive 索引补上归档计划文件 | `git status` 显示为 rename；全库 grep 已无旧栈命令 |

## 已完成（第五轮：浏览器语音播报）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **语音播报**（零依赖，Web Speech API） | 回答流式结束后整段朗读；右上角「朗读：开/关」切换，选择落 `localStorage`（默认开——展厅就是靠它讲解），朗读中出现「停读」按钮。三条现场取舍：**只读回答不读提问**、**流式结束才读**（边流边读会切成碎音）、**长文按句切片排队**（Chrome 对超长 utterance 会中途静默），并每 5 秒 `resume` 一次绕开 Chrome 约 15 秒后自动暂停的老毛病；朗读前先洗掉 Markdown 记号/链接/代码块；换问题、开新对话、闲置复位、组件卸载都会立刻停读。**行为对齐重写前的 React 版**（`web/src/hooks/useSpeech.ts`，原地重写时被丢掉）：默认开声、读完才读、可单独停读、`voiceschanged` 预热中文音色；新增的是切片排队、定时 resume 与文本清洗 | `web/src/composables/useSpeech.spec.ts` 10 项 + `web/src/App.spec.ts` 4 项（组件级接线：读完自动朗读、关掉一个字不读、新对话停读、停读按钮）；前端单测 7 → **27 项**；`npm run build`（vue-tsc + vite）通过 |
| 前端组件测试环境 | 新增 `@vue/test-utils` + `jsdom`（backlog 待做第 2 条要的就是这套）；`App.spec.ts` 用 `// @vitest-environment jsdom` 局部切换环境，node 环境的既有测试不受影响 | 全量 `npm test` 27/27 |
| 形象状态联动 | 语音播报期间虚拟形象保持「说话」态（`avatarState` 把 `speech.speaking` 并进去），读完回到空闲 | 组件测试覆盖（`speaking` 影响渲染分支） |

## 已修（第六轮：大屏可读性与界面细节）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **大屏上出现字面的 Markdown 记号** | 模型习惯 `**粗体**` 与 `*` 分点，前端当纯文本渲染 → 屏幕上显示「检测**无需停机**」。两头一起治：system 提示词要求直接输出纯文本（分点用「1.」/「·」），前端新增 `format.ts` 把残留记号转成加粗片段与列表块（只产出结构、不产出 HTML，模型输出里的尖括号永远只是文字） | 真机（无头 Chrome + CDP）提问实测：回答里已无 `**`；`format.spec.ts` 6 项覆盖粗体/列表/分段/代码围栏/落单记号/空回答 |
| **流式回答不是响应式的** | `push` 进响应式数组的普通对象被代理，而流式回调改的是原始对象 → 字段变更不被追踪；以前靠 `streaming` 变化顺带重渲染才碰巧读到新值，模板里一旦有基于消息内容的 computed 就渲染空答案（本次加 `formatAnswer` computed 时暴露） | 改成 `reactive()` 创建回答对象；`App.spec.ts` 4 项（jsdom 下挂载真组件）通过 |
| 界面细节 | 形象区四边留白 14 → 34px（框变小、人物等比略缩，可见比例 `--frame-ratio` 不变）；主标题 15.5 → 17px、副标题 12px 拉开层级；展区下拉补自绘箭头；降级横幅退一档视觉重量；列表记号固定占宽，折行文字与首行严格对齐 |
| 展区下拉自绘 | 原生 `<select>` 的展开列表是系统绘制的，与浅色极简的页面风格割裂。换成自绘：触发按钮 + 白卡片列表，严格等宽对齐（实测左边缘/宽度差 0 px）、选中项蓝色文字 + 小圆点、分层分隔线、轻弹出动画（尊重 `prefers-reduced-motion`）、Esc 与点空白关闭、带 `role=listbox/option` 与 `aria-expanded` | 真机截图 + vision 逐条核对（对齐/分隔线/选中态/投影/箭头朝上）；`App.spec` 新增 1 条（展开、选中标记、选择后收起并带 `?zone=` 重取推荐问题、Esc 与点空白关闭） |
| 技术问题只走聊天窗口 | 删掉「数据库未连接…请按 init.sql 初始化」的降级横幅与单独的错误横幅：回答失败的技术原因落在同一条回答下方（「技术问题：…」带左竖线），落库状态挪进运营视图「本机设置 → 数据留存」。展厅大屏不给参观者看技术信息 | 实测：后端停掉后提问 → 聊天窗口里显示「这条问题暂时没能回答，请再试一次。」+「技术问题：请求失败（500）」，页面上 0 个横幅；`App.spec.ts` 补两条（未连接时页面不提示 / 失败时错误在消息里） |
| 展厅大屏做减法 | 去掉标题右侧四个入口（资料条数 / 朗读开关 / 新对话 / 运营视图）与输入框下方那行操作小字；输入框收成聊天软件那种单行高度（静止 39px）。**功能没删**：运营视图改由 `?admin=1` 打开，朗读开关与「重新开始」收进抽屉的「本机设置」，朗读中保留页面上的「停读」 | 无头 Chrome 截图逐轮对照（1600×900 与 700×1000 两种版面）：形象区留白评为「合适、不偏挤」，回答分点排版整齐、无溢出、无错位；控制台无报错 |

## 已修（第七轮：安全加固与降级模式）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| 管理接口 fail-closed | 请求不是从本机回环地址进来且未配 `ADMIN_TOKEN` → 401（原来只有 `NODE_ENV=production` 强制，`HOST=0.0.0.0` + 忘配口令等于把统计/重载/诊断/同义词全对局域网开放）；`/api/health` 的 `adminTokenRequired` 与守卫同判据 | 实测绑 `0.0.0.0`：回环 `/api/stats` 200、经 LAN IP 401；单测 4 条（非回环/地址缺失/回环放行/健康上报一致） |
| CORS 错配 | 去掉 `access-control-allow-credentials`（`CORS_ORIGINS=*` 时回显任意 Origin + 允许携带凭据是经典错配；本服务不用 cookie） | 冒烟 56/56（不依赖该头） |
| `/api/feedback` 限流 | 公开写口纳入按 IP 限流（与两个 chat 接口共用一个桶） | 实测 `CHAT_RATE_PER_MIN=2` 时第 3 次 429；默认 30 时第 28 次起 429 |
| MySQL 最小权限 | `ALL PRIVILEGES` → `SELECT, INSERT, UPDATE, DELETE, CREATE`（仅 `znwd` 库） | 临时实例实测：建出 5 张表、问答 1 行 + 反馈 1 行、重启后恢复 |
| **降级模式写库白等 3 秒 + 日志刷屏** | 库挂掉时每次问答/反馈/定时裁剪都要等 Hikari `connection-timeout`（实测 3.0s/次），且 Hikari 每 65 秒刷一条建连 WARN + 16 行堆栈（同一根因反复刷，把真日志淹掉）。三层一起改：① 写路径与 `trimStorage` 都先问 `DatabaseStatus.shouldAttempt()`，已知不可用直接跳过；② `minimum-idle: 0` 去掉连接池的后台反复建连，另加每 60 秒的静默探活（恢复后无需重启即续写，health 也跟着变）；③ 压掉 `PoolBase` 每次重探的 WARN 堆栈（根因启动已报一次、health 如实上报） | 实测：反馈 3.0s → **0.019s**；降级静置 70 秒日志只有 **1 条 WARN、0 行堆栈**（原来约 3 段 ×16 行）；建库后**未重启**第 50 秒自动恢复落库，随后问答/反馈各落 1 行；单测 7 条 |
| 全仓安全核查 | 凭据、注入、XSS、管理面、日志、异常、Actuator 七项逐条核查（含命令） | 见 `docs/security.md` 第二、三节 |

## 已完成（第八轮：资料入库工具 + 本机 MySQL 初始化）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **资料入库工具移植**（旧 Node 版 `server/scripts/ingest-docs.ts`） | `mvn -q test-compile exec:java@ingest -Dexec.args="--src <目录> --zone <展区id> [--force] [--dry-run]"`：PDF 走 `pdftotext -layout -enc UTF-8`、txt/md 直接读、DOCX 内置解析（zip + `word/document.xml`，认得标题样式与 `w:outlineLvl`、编号段落、表格），三种来源过同一套规范化（丢页码与分隔线、合并断行、短行升级标题、表格行贴合）；按 `zones.json` 落 `knowledge/<展区目录>/` 并写 frontmatter；目标已存在默认报错 | 本机实测 6 个素材：中文 DOCX（标题层级/列表/表格）、中文 txt、子目录 md、带文字层 PDF 全部正确入库；扫描件 PDF 与旧版 `.doc` 按预期失败并给出下一步；dry-run 不写盘、`--force` 才覆盖；生成的文件被 `KnowledgeLoader` 正常加载（`[knowledge] 已加载 6 个片段`）；新增单测 **10 项** |
| **本机 MySQL 初始化完成**（原先挂在待做清单里） | `server/.env` 已配 `DB_*`，`server/db/init.sql` 已在正式实例执行过（应用账号只有 `SELECT/INSERT/UPDATE/DELETE/CREATE`） | 直连核查：`znwd` 库 5 张表齐全（`chat_log`/`feedback`/`session`/`session_message`/`uncovered_question`），`chat_log` **453** 行、`uncovered_question` **50** 行 |


## 已知取舍（不是 bug）

- `EMBED_PROVIDER=bag` 是特征哈希，不是语义向量：`/api/health` 会如实报 `semantic=false`、`degradedReason`，检索模式只报 `keyword`，不冒充 `hybrid`。要真语义检索需配 `openai_compat` 的 embedding 并 reload 重建索引。
- MySQL 不可用时服务照常讲解（不落库），`storageAvailable=false` 会在 `/api/health` 与前端顶部横幅同时提示——这是刻意降级，不是故障。
- 答案缓存只在"单轮且无历史"时命中（多轮上下文不同，复用会答错）。
- 诊断接口的 `q` 必须由调用方按 UTF-8 正确编码；在 GBK 控制台下用 curl 手拼中文会变成乱码（表现为"什么都被拦"），用 `python tools/smoke.py` 或浏览器访问可避免。
