# Changelog

本项目版本与变更记录。日期：YYYY-MM-DD。

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
