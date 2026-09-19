# Changelog

本项目版本与变更记录。日期：YYYY-MM-DD。

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
