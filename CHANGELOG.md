# Changelog

本项目版本与变更记录。日期：YYYY-MM-DD。

## [未发布] — 2026-09-22

知识业务资料替换为公司自有材料（版本号仍 1.2.0，`StatusController.VERSION` 未动）。

### Changed

- **知识库整批替换**：由项目申报书、大赛与项目概述三份 docx 重写为 13 篇业务文档，展区由 4 个变 5 个——
  `01_光伏清洁机器人` / `02_光伏医生运维系统` / `03_项目与团队` / `04_风场检测无人机` / `90_通识`，语料 134 → 111 块。
  8 篇演示资料、4 篇占位文档与 `_meta/demo-docs.md` 一并删除；`zones.json` 的 `service` 展区并入 `project`。
- **入前脱敏**：剔除 4 名团队成员姓名、身份证号、手机号（含写成 "177 3014 1207" 的一处）、2 个单位联系人手机与
  2 个统一社会信用代码；正文不留「来源/演示/待补」类说明。
- **闸门阈值不动（仍 8.1）**：新语料更同质，「光伏/组件/清洗」这类词的 IDF 整体下降，在域问句关键词分从 8.9+ 掉到 5~7，
  一度误拦 8 条。按「问句式小节标题」（访客原话做 `##` 标题、答案只写原文事实）把在域最低分抬回 8.398，
  误拦归零——**没有改 `.env` / 默认值 / CI**。
- **评测用例集 v2**：49 条单轮（46 条计分）+ 7 条追问，覆盖 5 个展区；46/46 top1 命中、闸门 0 误拦。
  删除 `svc-05`（报告模板在新语料里已无对应服务）；`mix-02` 期望改到光伏医生侧（该论点在新语料的落点）。

### Fixed

- **系统提示与拒答文案还写死旧展区**：`RagPipeline` 的 `SYSTEM_BASE` 与 `NO_HIT_REPLY` 仍写「光伏清洁无人机与风场检测无人机」，
  访客每次域外提问都会看到旧主题清单。已按现行业务改写成光伏清洁机器人 / 光伏医生智慧运维 / 项目与团队 / 风场检测无人机四项，
  并把「展厅参观」措辞对齐到展板场景。

### 已知不一致（本次只记录，不改代码）

- **标定工具的区间判据与闸门口径不同**：`HybridRetriever` 判闸门用 `keywordBestScore`（排序分，含同义词扩展），
  `Calibrate` 的区间判据却用 `keywordGateScore`（只算用户原话）并在输出里自称「与闸门同一口径」。
  按闸门口径区间成立（在域最低 8.398 / 域外最高 6.984，8.1 在区间内），按工具口径报「区间不成立」并退 2。
  两套数字都实测记录在 `docs/eval.md`；改口径要连带改工具 + 文档 + CI 判据，属于独立的一件事。

## [未发布] — 2026-09-21

检索质量与对外内容的一轮修复。版本号仍是 1.2.0（`StatusController.VERSION` 未动）。

### Fixed

- **跨标点 bigram**：早先把整段文字的单字抽出来连成一条链，「叶片检测？外观有裂纹」会造出「测外」这种不存在的词条；
  同义词扩展把备选词拼成一个字符串再切更糟——「组件 电站 清洗 积灰」造出「件电」「灰清」。
  这些垃圾词条带着真实 IDF 参与打分，是「域外问题被放行」的直接来源。`Retriever` 改为按连续 CJK 串取 bigram（查询侧与文档侧一致）。
- **同义词表里的「话题枢纽」**：「光伏」原来指向 组件/电站/清洗/积灰/清洁 五个泛词，
  一句「光伏和风电哪个更赚钱」靠它们攒到 10.96（高过在域最低 8.93）被闸门放行，模型拿一篇积灰清洗的文章硬答「盈利能力」。
  现在表里只放同义词与同域复合词（如 报告 → 检测报告/巡检报告/作业报告）。
- **阈值重标 6.3 → 8.1**：修完上述两处后区间重新成立（在域最低 8.856 / 域外最高 7.272，取中点）。
  四处同步：`server/.env`、`application.yml` 默认值、`HybridRetriever.DEFAULT_MIN_KEYWORD_SCORE`、CI workflow。
- **多轮追问被误判为域外**：句首词表补「刚才/刚刚/上面/前面/之前」，并允许往回看 3 轮用户提问
  （上一轮本身被拒答时主题在再上一轮，旧实现在这一步直接放弃）。实测「刚才说的第一个方案是什么」「上面提到的方案多久能做完」
  「再详细说说」由固定拒答变为正确回答；评测追问改写触发 5 → 6，改写后 top1 仍为 1.0。
- **来源面板重复卡片**：`RagPipeline.toSources` 现在按资料文件去重（问一次清洁问题，原来 4 条来源里 3 条同属一份文件），
  前端 `SourcePanel` 的 `:key` 同时带上下标——两个都会导致同名卡片与 Vue key 冲突。sources 4 → 2。
- **模型编造联系方式**：system 提示明确「资料里没写的地址/电话/邮箱/报价一律回答资料中未提供，不要推测、不要举例」；
  知识库里的占位邮箱（`bd@example-drone.local`）已从正文删除——它曾被原样答给参观者。
- **正文夹带运维说明**：8 篇演示资料的「演示资料（自动抓取…）来源：…」从正文移到 frontmatter
  （`source:` + `demo: true`）。正文每一行都会被切块、被检索、被展示在来源面板上，少 8 个纯说明块（134 → 126 块）。
- **诊断文案与判定口径不一致**：`RetrievalVerdict` 报的「关键词最高」改为闸门真正比较的那个分（排序分），
  只用原话的分另附一句；`distanceToGate` 同步。报一个数、判另一个数是最难排查的那类问题。
- **畸形参数被报成 500**：`GET /api/admin/diagnostics?topK=abc`（`MethodArgumentTypeMismatchException`）
  与 `PUT /api/chat`（`HttpRequestMethodNotSupportedException`）原先都掉进兜底 `Exception` handler，
  于是「参数写错」「用错方法」都变成 500「服务内部错误」——监控和客户端会当成宕机，运维还得翻日志才知道是自己发错了。
  现分别映射为 400 与 405（附 `allowed` 方法列表），另补 415；这三条是 `tools/security.py` 的 B16/B22 打出来的。
- **访客中途断开刷爆服务日志**：SSE 响应头已是 `text/event-stream`，客户端关页面/切屏时的 `IOException`
  被兜底 handler 接住后又要写 JSON 错误信封 → 再抛 `HttpMessageNotWritableException`，容器跟着再记两条 ERROR：
  **一次「关页面」= 3 个 ERROR + 上百行堆栈**。展厅里关页面与闲置复位是高频动作，日志被刷爆会把真问题埋掉。
  现由 `handleClientGone`（`IOException` / `AsyncRequestNotUsableException`）只记一行 INFO，且不带响应体。
- **缺 `x-content-type-options: nosniff`**：`CorsAndIdFilter` 给所有响应（含错误与 SSE）统一补上。
- **CI 的「等就绪」条件太弱，第一次真跑到 CI 上就挂了**：push 后 GitHub Actions 跑起后端作业，
  倒在「起服务并跑接口冒烟」——端口那时已经在监听，但 `ApplicationReadyEvent` 里的知识库加载与数据库探活还没做完，
  探测打在这一秒之间：`/api/health` 回 `knowledgeChunks:0`、`storageAvailable:false`，断言把原因报成「库没连上」（库其实是好的）。
  等待循环改成等「两个字段都正常」（最多 60 秒），断言里分开报「库没连上」与「知识库没加载（0 块）」；
  另两个实例（0.0.0.0 越权组与误配置组）的等待循环同样处理——它们也要加载知识库，未就绪时问答案例会失败。

### Added

- `RetrievedChunk` 增加 `gateScore`（只由用户原话词条贡献），诊断接口新增 `keywordGateScore` 字段与 `verdict` 里的对照说明：
  两个数差得多，就说明这次命中是同义词扩展抬上来的。
- 标定样本补 4 条实测漏过的域外问题（同行盈利/竞品价格/报价/发票）；标定报告同时给闸门分与排序分，并在输出里标明哪个才是判定用的。
- 单测 **44 → 50 项**：bigram 边界、扩展词不连词、诊断文案口径。
- 知识写作自检清单补一条「正文里不留待替换/示例/来源说明」。
- **`tools/security.py`：边界与安全用例**（黑盒、只用标准库，与 `smoke.py` 同风格）：54 项覆盖输入边界
  （畸形 body、2000/2001 字截断、4MB body、控制字符与 4 字节 emoji、`sessionId` 清洗、`topK` 越界、并发）、
  注入与密钥泄漏（SQL 注入串、路径穿越、提示注入、XSS 载荷、全端点密钥片段扫描）、日志脱敏（标记放在第 20 字之后才断言）、
  CORS 与安全头、越权（回环放行 / 非回环 fail-closed / 错口令 401）、SSE 边界（事件序列、中途断开）、限流（429 与重试提示）。
  CI 在冒烟之后跑一遍；用例编号、输入、期望与「已接受的风险」见 `docs/security-testing.md`。
- 前端 `format.spec.ts` 增「排版注入面」3 条：HTML 标签与事件属性、`javascript:` 链接语法、用粗体记号闭合属性，
  断言产出只有 `text/bold` 两个字段（没有 `href`/`src`/`onerror` 可塞）。
- **`tools/db-check.py`：库层核查** 8 项（本机 mysql 客户端 + 应用自己的最小权限账号，探测数据用完即删）：
  表齐全、账号无 `DROP/ALTER/GRANT`、`chat_log.message_preview` 只存 `hash#长度#前20字`、`message_len` 记原长、
  `answer_preview` 有截断、会话落库、未覆盖问题进表。**同时写明一条取舍**：`uncovered_question` 与
  `session_message` 存原文（运营补知识、多轮上下文需要），「不落原话」只保证 `chat_log` 与 JSONL 日志。
- 误配置 fail-closed 常驻用例 M01–M03：另起一个「绑 `0.0.0.0` 但忘配 `ADMIN_TOKEN`」的实例，
  验非回环访问管理接口一律 401、`/api/health` 对该来源如实报 `adminTokenRequired=true`、
  且 `/api/zones`、`/api/suggestions` 照常可用（fail-closed 不误伤讲解）。
- 前端 `App.spec.ts` 增 3 条 DOM 注入面用例（挂真组件 + 假 SSE）：回答里的 `<img onerror>`/`<script>`、
  粗体记号里夹的 `<b>`/`<iframe>`、来源面板片段里的同一载荷，断言 DOM 里没有对应元素被造出来、
  文本被转义成实体。断言刻意写成「查载荷那个元素」而不是「整页有没有 img」——页面上本来就有一个合法的形象图。
- CI backend 作业改为起三个实例（主 / 带口令的第二实例 / 忘配口令的误配置实例），
  一次跑完边界与安全 57 项；三个实例各用各的 `DATA_DIR`，避免事件日志互相插队。
- **`tools/offline-check.py`：把「除大模型外一律本地」变成可执行的检查**（5 项）：
  前端产物里没有任何联网引用（字体 CDN、脚本 CDN、埋点，O01–O03）、后端源码里能发起网络调用的入口
  只有 LLM/Embedding 两个适配器（O04，白名单之外一出现就失败）、依赖清单里没有云 SDK 与遥测库（O05）、
  `--runtime` 还能核对跑着的服务 provider 是否符合预期（O06/O07）。
  写这条的起因是「一体机是独立环境，网络只为接大模型」——这种要求靠发布前手查一遍守不住，
  一次顺手引个 CDN 字体就破了。检查器自己也做过**注入验证**：临时塞入 Google Fonts 外链、
  一个 `HttpClient` 探针类、一条 sentry 依赖，三项都被抓住；移除后恢复通过。
- CI 前端作业在构建之后跑 `python3 tools/offline-check.py`（那个作业里有产物与完整仓库）。
- `docs/deployment.md` 增「离线/内网部署：只有大模型出网」一节：逐组件说明没网时的表现
  （检索/闸门/落库正常；命中知识的问题需要模型，没网则友好失败；`LLM_PROVIDER=mock` 可无网演示；
  想在离线环境里也有真回答就把 `LLM_BASE_URL` 指向机器上的本地模型），并指出三个自检套件都能拷到一体机上跑。
- **CI 挂上 MySQL service 容器**（`mysql:8.4`）：以前 CI 里没有库，落库路径（会话恢复、`chat_log` 脱敏、
  未覆盖问题、最小权限账号）全都不被覆盖。现在按 `docs/deployment.md` 那两步建库——用 root 执行
  `server/db/init.sql`（`sed` 注入口令、`@'localhost'` → `@'%'`，并用 `MYSQL_ROOT_HOST='%'` 让容器内 root 能连），
  冒烟前先断言 `/api/health` 的 `storageAvailable:true`（库没连上就直接失败，免得「看起来在跑其实没落库」），
  再依次跑 smoke → security → `tools/db-check.py`。顺带把这份部署脚本本身也纳入了回归。
- **资料入库工具移植到新栈**（`exec:java@ingest`，旧 Node 版 `server/scripts/ingest-docs.ts`）：
  `../tools/mvn -B -q test-compile exec:java@ingest -Dexec.args="--src ./inbox --zone wind-inspect [--force] [--dry-run]"`。
  PDF 走 `pdftotext -layout -enc UTF-8`（没有文字层时明确报错、不产出空文件），txt/md 直接读，三种来源过同一套规范化
  （丢页码与分隔线、合并 PDF 逐行断行、短行升级 `##` 标题、表格行贴在一起），按 `_meta/zones.json` 落到 `knowledge/<展区目录>/`，
  自动带 `title/zone/zoneTitle/tags/source/ingestedAt` frontmatter；目标已存在默认报错、`--force` 才覆盖。
  **DOCX 改为内置解析**（zip + `word/document.xml`：标题样式与 `w:outlineLvl`、编号段落、表格），不再依赖 python 与 python-docx——
  少一个「现场机器没装 python-docx」的失败点，也让这条路径进了 CI 单测（解析前关掉 DTD 与外部实体）。
  实测：中文 DOCX（Heading 1/2 + 列表 + 表格）→ 标题层级、列表项、Markdown 表格全部正确；带文字层的 PDF 合并成段且丢掉页脚页码；
  扫描件 PDF 与旧版 `.doc` 按预期失败并给出下一步；生成的文件被 `KnowledgeLoader` 正常加载（`[knowledge] 已加载 6 个片段`）。
  入库后仍必须 reload → `exec:java@calibrate` → `exec:java@eval`（语料一变 IDF 就变，工具结尾会把这三步打出来）。
- `docs/knowledge.md` §8 从「新栈尚未移植」改写为实际用法：参数表、产出的 frontmatter 形态、自检清单。

### Changed

- `server/.env` 与 `server/.env.example` 清掉智谱 GLM 的配置示例与实测备注（已改用小米 MiMo；接入任何 OpenAI 兼容网关的方式保留在注释里）。
  历史记录不删，仍在本文件下方。

### Verified

- 后端单测 **60/60**（新增 `IngestDocsTest` 10 项：规范化、目标命名、写盘与覆盖策略、DOCX 解析与 XXE 拒收）、前端 **37/37**、契约冒烟 56/56、边界与安全 **57/57**（主实例 + 带口令的第二实例 + 忘配口令的误配置实例）、库层核查 **8/8**；
  检索评测 top1 **0.9333** / top3 **0.9667** / 闸门漏答 **0**（与基线一致）。
- 手工另验一组最危险的误配置：`HOST=0.0.0.0` + 忘配 `ADMIN_TOKEN` → 回环放行、内网地址访问管理接口 **401**，
  且 `/api/health` 对该来源如实上报 `adminTokenRequired=true`（不会出现「接口 401、health 说不需要口令」）。
- **CI 第一次真跑**（此前一直本地提交，Actions 从没执行过）：run #7（`21983b1`）暴露上面那条「等就绪」缺陷，
  修完 run #8（`a1ca7d9`）后端与前端作业全绿——建库（`init.sql` 建最小权限账号）、单测、检索评测、打包、
  起服务断言 `storageAvailable:true` 后跑契约冒烟 56 项、三实例跑边界与安全 57 项、库层核查 8 项、
  前端类型检查+构建+单测 37 项、本地化不变量 5 项，全部在真实 runner（Ubuntu 24.04 + MySQL 8.4 容器）上跑过。

## [1.2.0] — 2026-09-20

本节起版本号与 `StatusController.VERSION` / `openapi.json` 对齐：后端已由 Node/Fastify 原地重写为
Spring Boot 3.5.16（Java 21 目标）+ MyBatis + MySQL，前端由 React 重写为 Vue 3 + Vite 6，
**接口契约保持不变**（`/api/chat`、SSE 的 `meta→delta→done`、`noHit`、`sources` 全部照旧，见 `docs/api.md`）。
重写与加固的逐项记录在 `docs/optimization-backlog.md` 的第二/三/四/五轮。

### Security

- **管理接口 fail-closed**：请求不是从本机回环地址进来且未配 `ADMIN_TOKEN` 时一律 401（原来只有 `NODE_ENV=production` 才强制，`HOST=0.0.0.0` + 忘配口令等于全开）。`/api/health` 的 `adminTokenRequired` 同判据。
- **CORS 不再声明 `access-control-allow-credentials`**：`CORS_ORIGINS=*` 会回显任意 Origin，叠加该头是经典错配；本服务不用 cookie，管理口令走 `Authorization`，不需要它。
- **`/api/feedback` 纳入按 IP 限流**：公开写口，原先可刷统计与反馈。
- **MySQL 账号收窄为最小权限**（`SELECT/INSERT/UPDATE/DELETE/CREATE`，仅限 `znwd` 库），临时实例实测建表与落库均正常。
- **降级模式写库快速失败 + 日志不刷屏**：库不可用时写路径与定时裁剪都跳过（不再白等 Hikari `connection-timeout`，实测 3.0s → 0.019s）；去掉连接池的后台反复建连并压掉每次重探的 WARN 堆栈（降级静置 70 秒只剩 1 条启动提示、0 行堆栈）；新增每 60 秒的静默探活，**库恢复后无需重启即续写**，`/api/health` 的 `storageAvailable` 跟着翻转。
- 新增 `docs/security.md`：加固项、已核查项、已接受的风险与上线检查清单，每条带复核命令。

### Added

- **浏览器语音播报**（零依赖，Web Speech API）：回答流式结束后整段朗读；右上角「朗读：开/关」切换，
  选择落 `localStorage`（默认开），朗读中出现「停读」按钮。长文按句切片排队（Chrome 对超长 utterance
  会中途静默），每 5 秒 `resume` 一次绕开 Chrome 约 15 秒后自动暂停的老毛病；朗读前洗掉 Markdown 记号、
  链接与代码块；换问题、开新对话、闲置复位、组件卸载都会立刻停读。播报期间虚拟形象保持「说话」态。
  行为对齐原地重写前的 React 版（`web/src/hooks/useSpeech.ts`，重写时被丢掉）：默认开声、读完才读、
  可单独停读、`voiceschanged` 预热中文音色；新增切片排队、定时 resume 与文本清洗。
- 前端组件级测试环境：`@vue/test-utils` + `jsdom`，`web/src/App.spec.ts` 覆盖播报接线三条
  （读完自动朗读 / 关掉一个字不读 / 新对话停读 / 停读按钮）。前端单测 **7 → 27 项**。

### Fixed

- **大屏上出现字面的 Markdown 记号**：模型习惯用 `**粗体**` 与 `*` 分点，前端当纯文本渲染，展厅屏幕上直接显示 `检测**无需停机**`。两头一起治：system 提示词要求直接输出纯文本（分点用「1.」/「·」），前端 `format.ts` 再把残留记号转成加粗片段与列表块（只产出结构、不产出 HTML，天然无注入）。实测回答已无记号。
- **流式回答对象不是响应式的**：`push` 进响应式数组的普通对象被代理，但流式回调改的是原始对象，字段变更不被追踪——以前靠 `streaming` 变化顺带重渲染才碰巧读到新值，一旦模板里有基于消息内容的 computed 就会渲染出空答案。改成 `reactive()` 创建回答对象。
- **`NODE_ENV=production` 强制管理口令的规则从未生效**：`AppProperties.nodeEnv` 是 record 组件，
  relaxed binding 只认键 `znwd.node-env`，而 `application.yml` 里没有这个键，`.env` 里的 `NODE_ENV`
  绑不上——「生产未配 `ADMIN_TOKEN` 的管理接口一律 401」静默失效（编译、启动、其余单测全都不报错）。
  已显式写 `node-env: ${NODE_ENV:}`；实测不设 `NODE_ENV` → `/api/stats` **200**（开发放行），
  `NODE_ENV=production` → **401**。
- 新增配置接线守卫测试 `AppPropertiesBindingTest`：反射遍历 `AppProperties` 的每个字段，
  断言 `application.yml` 的 `znwd` 段里有对应 kebab-case 键（临时删掉 `node-env` 会变红）。
  后端单测 **30 → 33 项**。

### Changed

- 界面细节：形象区四边留白加大（人物等比略缩、可见比例不变）、主标题 15.5 → 17px 拉开层级、展区下拉补自绘箭头（`appearance: none` 后原本没有可点击提示）、降级横幅退一档视觉重量。
- 技术信息不上大屏：删掉「数据库未连接…请按 server/db/init.sql 初始化」的降级横幅与单独的错误横幅，回答失败时的技术原因改为落在**同一条回答下方**（带左竖线的「技术问题：…」一行）；落库状态挪进运营视图的「本机设置 → 数据留存」。
- 展区选择换成自绘下拉：原生 `<select>` 的展开列表由系统绘制、样式做不了，改为「触发按钮 + 白卡片列表」（与触发按钮严格等宽对齐、选项 hover 浅灰、选中项蓝色文字 + 小圆点、「全部展区」与具体展区之间一条分隔线、12ms 级轻弹出动画、Esc 与点空白关闭、`role=listbox/option` + `aria-expanded`）。
- 展厅大屏做减法：去掉标题右侧的四个入口（资料条数 / 朗读开关 / 新对话 / 运营视图）与输入框下方那行操作小字；输入框收成聊天软件那种单行高度（静止 39px，内容多了才往上长）。运营视图改由 `?admin=1` 打开，朗读开关与「重新开始」收进抽屉里的「本机设置」，朗读中保留页面上的「停读」按钮。
- 文档收尾：根 `plan.md`（Node 时代交接文档）归档为 `docs/archive/old-node-plan.md` 并加归档说明；
  `knowledge/_meta/demo-docs.md` 里残留的旧栈命令换成新栈命令；README/docs 里的单测数量同步更新。

## [0.13.0] — 2026-09-19

检索排序与成本优化：修掉「非语义向量仍参与融合」，参数改为数据驱动，闸门拦截不再调用大模型。

### Fixed

- **bag（非语义）向量仍参与 RRF 融合**：`mode` 如实上报 `keyword`，但排序被哈希向量的
  噪声命中搅动，top1 被压低。现在非语义向量只做诊断上报、不参与融合（与闸门一致）。
  实测 top1 0.8667 → **0.9333**、top3 0.9333 → **0.9667**。
- 单元测试里有一条断言把该错误行为固化成了期望（「未加闸门仍可看到向量路噪声命中」），
  已改为断言正确行为（噪声不再进候选，余弦仍在诊断里可见）。

### Changed

- **同义词扩展词降权**（权重 0.45）：扩展是提示不是要求。此前「闪光灯→拍摄」会把
  讲拍摄方案的风机文档抬到展厅须知之上。
- **词频增益封顶**（2.2）：抓来的长网页靠反复出现「作业/流程/运维」压过短而精准的文档。
- 打分参数改为可注入 + 单一默认值（`DEFAULT_SCORING`），新增 `npm run tune:scoring -w server`
  网格搜索（top1/top3 + 闸门余量）。当前参数即该脚本选出的最优组合；
  长度归一化实测无效（不提 top1、闸门余量掉到 1 附近），默认关闭但保留开关。

### Added

- **闸门拦截不调用大模型**：拒答走固定回复（`provider='gate'`、`usage` 为空）。
  实测域外问题 **4.7s/782 tokens → 0.04s/0 tokens**；需要模型措辞时设 `NO_HIT_LLM=true`。
- 单元测试 41 条（新增：扩展词拆分与降权、闸门拦截零调用、非语义向量不融合）。

### Verified

- `npm run verify` **5/5**（top1 0.9333 ≥ 0.9，不再需要下调期望）；`gateBlockedCount=0`。
- 重标定：域外最高 3.654 / 在域最低 8.933 → `MIN_RELEVANCE_SCORE=6.3` 仍然成立（余量 42%）。
- 真实链路（MiMo v2.5）：域外问题 0.04s、无 token；在域问题 6.2s、1710 tokens；
  `/api/stats` 只统计真实调用（`calls=1`）。

## [0.12.0] — 2026-09-19

演示语料入库跑通全链路，并修掉「评测与服务用的不是同一套阈值」这一验证盲区。

### Fixed

- **评测/标定与服务不同源**：`eval-retrieval` 构造检索器时不传阈值（一直用代码默认 3.8），
  `calibrate` 干脆没加载 `.env`（报告里「当前生效」显示的是默认值而非线上值）。
  现在阈值只在 `resolveThresholds()` 一处解析（`hybridRetriever.ts`），`.env` 加载只有
  `src/config/dotenv.ts` 一份实现，服务/评测/标定三个入口共用；`index.ts` 里硬编码的
  `|| 3.8` / `|| 0.35` 一并去掉。补 2 条单测（env 覆盖、空串/非法值退回默认且不产生 NaN）。
- `calibrate.ts` 收尾处引用未定义变量 `retriever` 导致脚本必然崩溃（`ReferenceError`），
  改为读取共享阈值，并新增「阈值距域外最高分余量 < 10%」的告警。

### Added

- 演示语料：8 篇公开资料抓取入库（`knowledge/*/demo-*.md`），用于真实正文到位前跑通
  「入库 → 分块 → 检索 → 闸门 → 标定 → 评测」。来源与删除方式见 `knowledge/_meta/demo-docs.md`。

### Changed

- 重标阈值：演示语料下 chunk 23 → 134，`MIN_RELEVANCE_SCORE` 3.8 → **6.3**
  （域外最高 3.654 / 在域最低 8.883；原 3.8 只剩 3.8% 余量，闸门偏松）。
- `docs/eval.md` 增加演示语料实测对照（top1 0.9667 → 0.8667，附「非代码回归」的原因说明）；
  `docs/api.md` 增加单一来源约定与 `LLM_*` 环境变量说明。

### Verified

- 真实链路（MiMo v2.5）：`积灰对发电量影响` → 命中演示文档、4 来源、6.6s、1020 tokens；
  `叶片裂纹怎么发现` → 9.8s、1526 tokens；`今天上海天气` → `noHit=true`、0 来源、模型按闸门拒答。
- 单测 38/38；`npm run verify` 5/5；`gateBlockedCount=0`（新阈值未误伤评测用例）。

## [0.11.0] — 2026-09-19

接入小米 MiMo v2.5（关闭思考模式）跑通真实链路，并让 token 成本可见。

### Added

- **`LLM_EXTRA_BODY`**：JSON 合并进请求体。MiMo 的 `thinking` 默认 `enabled`（官方文档：默认开、且会消耗
  `reasoning_tokens`），必须显式传 `{"thinking":{"type":"disabled"}}`；实测返回 `reasoningTokens: 0`，确认已关。
- **`LLM_MAX_TOKENS`**：输出 token 上限（`max_completion_tokens`），成本闸门——展厅回答不需要长文。
- **token 用量统计**：`/api/chat`、`/api/chat/stream` 的 `done` 事件返回 `usage`
  （`promptTokens/completionTokens/reasoningTokens/totalTokens`）；`/api/stats` 累计
  `tokens{prompt,completion,reasoning,total,calls}`，随 `PERSIST_STATE` 一起落盘。命中缓存不计数（没花钱）。
  `reasoning > 0` 就是思考模式没关的信号。

### Changed

- `docs/api.md`：补 `usage`、`tokens` 字段与 `LLM_EXTRA_BODY`/`LLM_MAX_TOKENS`/`LLM_MAX_RETRIES`/`LLM_TIMEOUT_MS`。
- `server/.env.example`：补 MiMo（`api.xiaomimimo.com/v1`、`mimo-v2.5`）与智谱 GLM 两套示例。

### Verified

- 真实链路（MiMo v2.5，thinking 关）：非流式 2.7~5.6s、流式首字 3.65s，`mode=rag`、4 条来源、答案基于片段；
  单次用量 prompt 390 / completion 77 / reasoning 0。
- `npm run verify`（用 `LLM_PROVIDER=mock` 跑，避免消耗付费额度）5/5 通过。

## [0.10.1] — 2026-09-19

接入真实 LLM（智谱 GLM，OpenAI 兼容网关）时暴露的客户端健壮性问题修复。

### Fixed

- **过载/限流直接抛错**：免费档与共享网关会返回 429（智谱业务码 1305「访问量过大」），原实现一次失败即 500。
  现按 429/408/5xx/业务码重试，退避 1s/2s…（尊重 `retry-after`），默认重试 2 次；
  额度用尽类（1303/1304）不重试——重试无意义，直接报错让运营处理。
- **HTTP 200 包错误体**：部分网关用 200 + `{error:{code,message}}` 表达失败，原实现会走到「LLM returned empty content」，
  现在识别 error 字段并按可重试性处理。
- **推理模型的思考内容混入回答**：GLM-4.7 等会在流里先发 `reasoning_content`，原实现只读 `content`（本就正确），
  但类型未声明、非流式路径未显式忽略；现明确只取正文，思考内容不进回答、不进 TTS。
- 超时默认值上调：非流式 60s → 90s，流式 90s → 180s（推理模型单次可达 20~40s）。

### Added

- `LLM_MAX_RETRIES` / `LLM_RETRY_BASE_MS` / `LLM_TIMEOUT_MS` 可配；`.env.example` 增 GLM 接入示例。

### Test

- unit **36/36**（新增重试判定：429/5xx/1305 可重试，400/401/1303 不重试，`retry-after` 透传）

### Notes

- 实测（未充值 key 的免费档，2026-09-19）：`glm-4-flash` 3/3 成功、1.3~1.5s；
  `glm-4.5-flash` 12~19s；`glm-4.6-flash` 需余额（1220）；`glm-4.7-flash` 1/3 成功、18.8s、流式首字 21.8s。
  展厅场景建议 `glm-4-flash`；预算到位后可用更强模型，重试逻辑对任何网关都适用。

## [0.10.0] — 2026-09-19

补齐 0.9.0 评审报告里「仍未做」的可在本机完成项：多轮指代改写、资料入库、状态持久化、一键验收与 CI。

### Added

- **多轮指代改写**（`server/src/rag/rewrite.ts`）：本轮关键词检索拿不到达标候选、且提问是省略式追问（「那要多久？」）时，把上一轮命中的主题词补进检索查询。只在必要时触发，回答仍按原问题。
  实测（`followUps` 用例）：不改写 top1 **0.6667** → 改写后 **1.00**（救回「那要多久？」→ 叶片检测说明、「那怎么报名？」→ 服务、培训与合作）。
- **资料入库**（`server/scripts/ingest-docs.ts`，`npm run ingest -w server -- --src <目录> --zone <展区id>`）：PDF（pdftotext）/ DOCX（python-docx）/ txt / md → `knowledge/<展区>/<名>.md`，带 frontmatter（title/zone/tags/source）。
  - 无文字层的扫描件会明确报错（提示走 OCR），不会写出空文件；
  - 目标已存在需 `--force`，支持 `--dry-run`；
  - 已验证：ASCII PDF 与中文 DOCX（含标题层级与表格）转换正确，扫描件按预期拒绝。
- **状态持久化**（`server/src/state/persist.ts`，`PERSIST_STATE=true`）：会话、问答计数、反馈、未覆盖清单落盘 `DATA_DIR/state.json`（原子写），启动恢复、定时与退出时落盘。
  实测：硬杀进程后重启，`chatTotal`/`noHit`/反馈统计/未覆盖清单/会话历史全部恢复。
- **未覆盖问题清单**：`GET /api/admin/uncovered` 返回 noHit 的原始提问（内存、限量 `UNCOVERED_LOG_SIZE`，默认 50，0 关闭），`/api/stats` 增 `rewritten`/`uncoveredCount` 计数——补资料终于有靶子。
- **一键验收**（`npm run verify`）：build → unit → 起 dist 服务 → api-audit → eval，独立端口 8791，不干扰开发中的 8787；`--quick` 跳过 web 构建与 eval。
- **CI**：`.github/workflows/ci.yml`（build + unit + eval + calibrate + 起服务跑 api-audit）。
- `npm run eval:retrieval -- --no-write`：只打印不写基线，便于实验（如换 KNOWLEDGE_DIR）时不污染仓库。

### Changed

- `calibrate` 输出当前生效阈值与代码默认值，不再写死文案。
- api-audit 增 `admin-uncovered-list` 检查（**36/36**）。

### Test

- unit **35/35**（新增改写触发/不触发边界、未覆盖清单限量与关闭、持久化往返与损坏文件容错）
- api-audit **36/36**；`npm run verify` **5/5 通过（约 10s）**
- eval：top1 0.9667 / top3 1.00 / 闸门漏答 0 / 追问改写 top1 1.00

### Notes

- 入库文档会改变 IDF：实测把 2 篇测试文档入库后 `knowledgeChunks` 23 → 28、top1 0.9667 → 0.9333。
  **入库后必须重跑 `calibrate` + `eval:retrieval`**（本次实测阈值区间未变，仍建议每次核对）。

## [0.9.0] — 2026-09-18

第二轮加固：入参边界、CORS 白名单、统一 404 信封、相关性闸门、检索如实上报、分块器、反馈闭环、测试与文档对齐。
起点是 MiMo 版 0.8.0 的一轮实测：单测 19/19、api-audit 21/21 属实，但边界与产品闭环比文档写的弱。

### Fixed

- **非字符串入参导致 500**：`{"message":12345}` 原样 `trim()` 抛 TypeError → 500。新增 `http/request.ts` 统一解析，现返回 400 `validation_error`（`message must be a string`）。
- **CORS 任意源放行**：`origin: true` 会把 `https://evil.example` 原样回显，SSE 路由还手写 `access-control-allow-origin: *`。改为 `http/cors.ts` 统一策略：默认仅放行 localhost/127.0.0.1，生产用 `CORS_ORIGINS` 白名单，SSE 与 HTTP 同一口径。
- **404/405 绕过统一信封**：未知路由原先返回 Fastify 默认体（含 `statusCode`、无 `requestId`）。新增 `setNotFoundHandler` → `{ error: "not_found", message, requestId }`。
- **检索永远「有命中」**：相关性无下限，任何问题都会拿无关片段硬答（「今天上海天气怎么样？」原样返回 4 条风场资料 + 「根据展厅资料」）。现引入闸门：关键词分低于 `MIN_RELEVANCE_SCORE` 且语义向量路不达标时返回空命中，回答明确说资料中没有并给推荐问法。
- **单字命中污染打分**：中文分词把单个汉字也算命中，导致「今天上海天气怎么样」关键词分 2.46，高于若干真实问题。改为 bigram-only + IDF 加权。
- **`retrieval`/`stats().mode` 写死 `hybrid`**：即使向量路是特征哈希或为空也这么报。现按实际参与情况上报 `hybrid`/`keyword`，并给出 `semantic`/`degradedReason`/`thresholds`。
- **SSE 回答不进答案缓存**：流式问完再非流式问会重跑一遍。现两个入口共用缓存读写，SSE 命中缓存时直接回放。
- **SSE 未做反代友好处理**：补 `x-accel-buffering: no`、15s 心跳注释、客户端断开即停止生成。
- **反馈无法关联问题**：`/api/feedback` 未带 `question` 时，从会话里取最后一条用户提问。
- **限流淘汰非 LRU**：命中即刷新插入序，活跃 IP 不再被误删。
- **分块器不适应长文档**：原先只在段落累计超长时才切，且超长按字符硬切无重叠。现按 markdown 标题分段、段落打包、超长段落滑窗切分带重叠。
- 清理无引用导出（`relatedFromChunks`、`SYNONYM_MAP`、`SUGGESTIONS`、`l2`）。

### Added

- `server/scripts/calibrate.ts` + `npm run calibrate -w server`：在现有知识库上标定在域/域外分数区间，给出 `MIN_RELEVANCE_SCORE` 建议值（当前区间：域外最高 2.64 < 3.8 < 在域最低 5.05）。
- 前端反馈闭环：回答下方「有帮助 / 没帮助」→ `POST /api/feedback`，失败回滚标记；命中闸门时自动展开推荐问法。
- `noHit` 字段贯穿 `/api/chat`、SSE `meta`/`done`、`/api/stats`（`noHit` 计数 = 下一批要补的知识）。
- `/api/admin/feedback-stats` 增加 `recent`（含正向反馈，便于核对某条回答）。
- `/api/openapi.json` 补 components schemas（ChatRequest/ChatResponse/Source/Error）与鉴权声明。
- 前端 `onMeta` 提前渲染来源与「未覆盖」提示；`busy` 时仍可继续输入。

### Changed

- 前端占位形象去掉「Live2D 就绪」等技术提示与待机徽标（0.2.2 曾声称删除，实际仍在）。
- `Composer` 发送中按钮显示「生成中」，输入框不再禁用。
- `RateLimiter`、`HybridRetriever`、`Retriever`、`loader.chunkText` 的行为变化均补了单测。

### Test

- unit **32/32**（新增入参校验、CORS 策略、分块器、bigram/IDF 打分、闸门与如实上报、noHit 统计、SSE 缓存一致性、限流 LRU）
- api-audit **34/34**（新增 CORS 拒绝、非字符串 400、404 信封、闸门两侧、SSE 反代头、SSE 缓存、反馈问题回填、health 检索真相、openapi schemas）；脚本不再硬编码 `E:/znwd/...` 绝对路径
- `npm run eval:retrieval`：**top1 0.9667（29/30）/ top3 1.00**，较 0.8.0 的 0.90/1.00 提升；`knowledgeChunks` 8 → 23（标题感知分块）

## [0.8.0] — 2026-09-18

Phase B/C：回答质量评测闭环 + 展览运营（`plan.md`）。

### Added

- 检索评测：`server/eval/retrieval-cases.json` + `npm run eval:retrieval` → `docs/eval/baseline.json`（bag 基线 top1 **0.90** / top3 **1.00**）  
- `docs/eval.md`：评测方法、C1/C2 内网 Embedding/LLM 接入步骤  
- `GET /api/admin/feedback-stats`（JSON / `?format=csv`）；feedback 支持可选 `question`  
- 展览 zone 联动：URL `?zone=`、`window.znwdSetZone(zoneId|mediaId)`、`znwd:zone` CustomEvent  

### Changed

- 答案缓存 key 含 retriever **generation**（K3），reload 后不串代  
- 同义词表扩展（作业/模板/触摸/展品等），评测 top3 命中率 0.93→1.00  
- `plan.md` Phase A/B/C 勾选完成  

### Test

- unit **19/19**；api-audit **21/21**（含 feedback-stats）；web/server build PASS；`npm run eval:retrieval` bag top1 0.90 / top3 1.00  

## [0.7.0] — 2026-09-17

Phase A 可上线加固（`plan.md` S1–S3 / E1–E4 / P1）。

### Security

- `HOST` 默认改为 `127.0.0.1`；`.env.example` / `deployment.md` 写明生产监听与反代建议  
- `NODE_ENV=production|prod|staging` 或 `REQUIRE_ADMIN_TOKEN=true` 时，未配置 `ADMIN_TOKEN` 的 `/api/stats`、`/api/knowledge/reload` 返回 401  
- 统一错误信封 `{ error, message, requestId }`；500/流式 error 不泄露堆栈与内部路径  

### Changed

- 抽取 `runChat` / `streamChat`（`server/src/rag/runChat.ts`），`/api/chat` 与 `/api/chat/stream` 共用检索、会话、缓存与日志  
- `HybridRetriever` 引入 **generation** 与串行原子 `replace`；`VectorStore` 临时 Map 构建 + 索引文件 tmp→rename  
- `JsonlStore`：默认 message **hash** 预览（`LOG_MESSAGE_MODE`）、按 `LOG_MAX_BYTES` 日切轮转、`flush()`  
- `SIGTERM`/`SIGINT` 优雅退出：`app.close` + 日志 flush + 8s 超时保护  
- 前端 `sendChatStream` SSE 流式渲染；失败自动回退 `POST /api/chat`；TTS 使用完整答案  

### Test

- unit 17/17（新增 adminOk/requireToken、errorPayload、日志脱敏/轮转、retriever generation、runChat）  
- api-audit 20/20  

## [0.6.0] — 2026-09-17

### Added

- SSE `POST /api/chat/stream`；答案 LRU 缓存；JSONL 事件日志  
- 领域同义词检索扩展；Mock grounded 摘要回复  
- `GET /api/openapi.json`；可选 `ADMIN_TOKEN` / `KNOWLEDGE_WATCH`  
- 单元测试 `npm test -w server`；API 审计脚本 `server/scripts/api-audit.mjs`  
- 审计报告 `docs/code-audit.md`  

### Fixed

- 流式接口 `stream({ messages })` 参数  
- 答案缓存命中时写入会话，避免追问丢上下文  
- knowledge reload 清空答案缓存  
- feedback rating 类型导致构建失败  

### Test

- unit 10/10；api-audit 20/20  

## [0.5.2] — 2026-09-17

### Changed

- 形象改为 **Three.js 原创职业女讲解员**（鹅蛋脸、长直发、淡妆贴图、西装+绿丝巾）  
- 支持自动加载 `web/public/models/hostess.vrm`（自备授权）；无模型时用程序化角色  
- 左栏形象区铺满，约占屏幕左 1/3  

## [0.5.1] — 2026-09-17

### Changed

- 前端形象改为**豆包风格**扁平 SVG 二维角色（圆头绿身、小芽、口型/眨眼/思考动效）  

## [0.5.0] — 2026-09-17

### Changed

- 知识库业务切换为：**光伏清洁无人机** / **风场检测无人机**（含服务合作、展厅须知）  
- 展区 zones、推荐问题、系统提示与前端欢迎语同步无人机主题  
- 文档体系更新：`docs/README.md`、`knowledge.md`、`architecture.md`、`code-review.md`  

### Fixed

- 向量索引按内容指纹重建，避免知识变更后检索陈旧向量  
- suggestions/zones 每次请求读取 `zones.json`，避免 reload 后短暂旧数据  
- 静音时语音状态强制复位为 idle  
- 前端 ChatResponse 类型补全 retrieval/zone 字段  

## [0.4.0] — 2026-09-17

Hybrid RAG 落地。

### Added

- 知识库按展区目录重构 + `_meta/zones.json`（分区/推荐/媒体映射）  
- Hybrid 检索：关键词 + 向量 **RRF** 融合  
- Embedding 适配：`bag`（离线默认）/ `openai_compat`（内网向量 API）  
- 向量索引持久化 `server/indexes/vectors.*.json`  
- `GET /api/zones`；`GET /api/suggestions?zone=` 按展区切换推荐  
- chat `sources` 带 `zone`/`vectorScore`/`keywordScore`；响应 `retrieval: hybrid`  

### Notes

- 生产建议 `EMBED_PROVIDER=openai_compat` + 中文 bge 类模型  
- `bag` 仅为离线兜底，不是语义嵌入  

## [0.3.0] — 2026-09-17

### Added

- 检索：中文二元组 + 标题加权  
- `GET/DELETE /api/sessions/:sessionId` 会话查看/删除  
- `POST /api/feedback` 点赞点踩  
- `GET /api/stats` 运行统计与最近问答  
- `GET /api/knowledge/list` 知识文件清单；reload 返回分文件块数  
- 每 IP 限流 `CHAT_RATE_PER_MIN`（默认 30/min），chat 超限 429  
- chat 响应增加 `latencyMs`；health 增加 `activeSessions`/`uptimeSec`  

## [0.2.2] — 2026-09-17

### Changed

- UI 精简：去掉顶栏「在线/连接中/服务未连接」状态胶囊  
- 去掉形象区「AI 虚拟接待员 · Live2D 就绪」及开发提示、待机徽标  

## [0.2.1] — 2026-09-17

### Changed

- 布局改为：整页 UI 仅占**左 1/3**，虚拟形象在上、聊天框在下；右侧 2/3 留白  

## [0.2.0] — 2026-09-17

接待体验增强（feature: reception-ux）。

### Added

- 会话多轮上下文：内存 `SessionStore`，同 `sessionId` 最近 6 轮 / TTL 10 分钟  
- `GET /api/suggestions` 推荐问题；前端 chips 点击即问  
- 闲置 **120s** 自动复位（新会话、欢迎语、停朗读）  
- 顶栏连接状态（连接中/在线/服务未连接），15s health 探测  
- 左侧「重新开始」按钮  

### Notes

- 会话仅存进程内存，重启即清空；无 STT/向量库  

## [0.1.0] — 2026-09-17

首个可运行框架（feature/virtual-receptionist）。

### Added

- npm workspaces monorepo：`server` + `web` + `knowledge` + `docs`  
- 后端 Fastify：`GET /api/health`、`POST /api/chat`、`POST /api/knowledge/reload`  
- 本地 RAG：Markdown/TXT 加载、分块、关键词检索 top-k  
- 可插拔 LLM：默认 `mock`；`openai_compat` 支持内网网关  
- 前端 Vite + React：左约 1/3 虚拟形象占位、右约 2/3 对话  
- 浏览器 TTS 自动朗读、静音/停止；与形象 mood 联动  
- 示例知识库 3 篇；功能 Spec 与文档索引  

### Fixed

- Mock 在无命中时仍声称「已有院内资料」（与 `mode=llm_only` 矛盾）  
- `.env` 改为相对 `server` 目录加载  
- `voiceReady` 初值、`speechSynthesis.cancel` 守卫、message 长度截断  

### Notes

- Live2D 为 CSS 占位，模型接入见 `web/public/live2d/README.md`  
- 无 STT、无鉴权，仅适合内网单机演示  

---

## 模板

```markdown
## [x.y.z] — YYYY-MM-DD

### Added
### Changed
### Fixed
### Notes
```
