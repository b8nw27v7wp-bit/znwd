---
feature: phase-a-hardening
status: delivered
updated: 2026-09-17
branch: feature/virtual-receptionist
commits: 57bb6dd4e7c2e0a20976566d5966e806e0d0b280..566e507
---

# Phase A 可上线加固

## Report

**What was built** — 按 `plan.md` Phase A 完成可上线加固：`HOST` 默认 `127.0.0.1`；生产/`REQUIRE_ADMIN_TOKEN` 下管理接口强制 `ADMIN_TOKEN`（否则 401）；统一错误信封 `{error,message,requestId}` 并全局 `setErrorHandler`（5xx 不泄露堆栈）；`runChat`/`streamChat` 统一 `/api/chat` 与 SSE 业务链路；`HybridRetriever` generation + 串行原子 replace，`VectorStore` 整包 `data` 快照 + `searchOn`，检索 chunk 对齐 keyword 快照；JSONL 默认 message hash 预览 + `LOG_MAX_BYTES` 轮转 + `flush`；SIGTERM/SIGINT 优雅退出；前端 SSE 流式渲染，未收到 `done` 或失败时回退 POST `/api/chat`，TTS 用完整答案。

**Verification** — `npm run build -w server` / `-w web` PASS；`npm test -w server` **17/17**；`node server/scripts/api-audit.mjs` **20/20**。独立 Review：critical（T5 混代、SSE 断流当成功）已修复并复审通过；major（errorHandler、analytics 预览脱敏、CHANGELOG 与代码一致）已处理。

**Journey log** — write 工具对含模板字符串的大文件偶发 JSON 失败，改用 edit 补丁更稳。后台 `Start-Process` 在本环境可能被回收，API 审计与起服放在同一命令内完成。评审先于 `vectorStore` 原子化落盘，复审确认 `data` 快照 + `searchOn` + chunk 对齐已合入。短消息（≤20 字）在 hash 预览的 clear 前缀中仍可辨认，属 Phase A 既定取舍。

## [S1] Problem

`plan.md` Phase A 指出当前后端与前端尚不能安全上线展厅环境：默认全网卡监听、管理接口在未配 token 时开放、错误响应可能泄露内部信息、`/api/chat` 与 SSE 逻辑重复、reload 与检索并发可能混用索引、JSONL 含完整消息且无轮转、进程无优雅退出、前端仍阻塞等待完整 JSON。本特性按 plan Phase A 一次落地这些加固与产品侧 SSE 流式。

## [S2] Design

### 2.1 安全默认（S1 / S2 / S3）

**S1 监听地址**

- 代码默认 `HOST=127.0.0.1`（`server/src/index.ts`）。
- `server/.env.example`：`HOST=127.0.0.1`，注释说明跨机由反代/防火墙暴露。
- `docs/deployment.md`：生产推荐 `HOST=127.0.0.1` + Caddy/nginx 反代。

**S2 ADMIN_TOKEN 强制**

- 环境判定 `requireAdmin`：
  - `REQUIRE_ADMIN_TOKEN=true`，或
  - `NODE_ENV` ∈ `production` / `prod` / `staging`
  - → 管理路由（`GET /api/stats`、`POST /api/knowledge/reload`）在未配置 `ADMIN_TOKEN` 时返回 **401**，启动日志 `error` 标明原因。
- 本地开发（`NODE_ENV` 空/`development`/`test` 且未设 `REQUIRE_ADMIN_TOKEN`）：无 token 时保持现状开放，启动 `warn` 提醒。
- `adminOk(header, token, opts)`：`opts.requireToken === true` 且 `!token` → false。
- `.env.example` / `deployment.md` 写清生产必须设置 `ADMIN_TOKEN`。

**S3 错误脱敏**

- 任意 5xx / 业务失败 body 统一形态：

```json
{ "error": "internal_error", "message": "服务内部错误", "requestId": "<id>" }
```

- `error` 为短码：`validation_error` | `rate_limited` | `unauthorized` | `internal_error` 等。
- 400/401/429 保留可理解的 `message`（如「消息不能为空」），但不附堆栈/路径/`err.message`。
- 详细异常只进 Fastify logger，字段含 `requestId`。
- SSE：`event: error` 数据同样 `{ error, message, requestId }`。
- requestId：`req.id`（Fastify 默认）或响应头 `x-request-id`。

### 2.2 业务复用 runChat（E1）

新增 `server/src/rag/runChat.ts`：

| 符号 | 职责 |
|------|------|
| `prepareChat` | 校验后已传入的 message；读 history；算 cache key；无 history 时尝试 LRU |
| `completeWithModel` | `answerQuestion` 或走 stream 路径；产出 `RagAnswer` |
| `finalizeChat` | `sessions.append`、analytics、JsonlStore、（非 stream 且 history 空时）写缓存 |
| `runChat(deps, input)` | 非流式完整链路，返回 HTTP chat 载荷 |
| `streamChat(deps, input)` | 与 runChat 共用 prepare/finalize；中间 yield meta/delta/done |

约定：

- 限流、空消息校验、sessionId 清洗留在 **route 层**（HTTP 关注点）。
- `/api/chat` 与 `/api/chat/stream` 均只调 `runChat`/`streamChat`，不再各自实现检索/会话/日志。
- 单测可直接测 `runChat`（不启动 HTTP）。

### 2.3 Retriever generation / 原子 replace（E2）

`HybridRetriever`：

- 内部持有不可变快照 `{ gen, keyword: Retriever, ready }`。
- `replace(chunks)` 串行（promise chain）：
  1. 新建独立 `Retriever` 并灌入 chunks；
  2. `vectors` 侧 `tryLoad` 失败则 `build`（`VectorStore` 亦用临时 Map 建完再 swap，见下）；
  3. 原子替换 `this.snapshot = { gen: prev.gen+1, keyword, ready: true }`。
- `retrieve` / `list` / `stats` 读取**同一 snapshot 引用**（Node 单线程赋值原子）。
- `generation()` getter 暴露当前代号。
- `VectorStore.build`：在局部 `nextById/nextVectors` 中构建，完成 persist 后再赋给实例字段，避免 search 读到半截 Map。

验收：并发 chat 与 reload 时检索始终属于同一完整代；`stats().generation` reload 后递增。

### 2.4 日志脱敏与轮转（E3）

`JsonlStore`：

- 构造可选 `{ maxBytes, dateProvider }`，默认 `LOG_MAX_BYTES=5_000_000`。
- 写入前 `stat` 当前文件；超过 maxBytes 则 rename 为 `events.<YYYY-MM-DD>.jsonl`（同名已存在则加 `.1`…），再写新文件。
- 新增 `flush(): Promise<void>` — await 内部 chain。
- chat/feedback 日志字段：
  - `messagePreview`：默认 **hash**（`hashStr(message)`）+ 长度 + 前 20 字符；不再写入完整 question。
  - `answerPreview` 仍截断 200 字。
- 环境变量：`LOG_MAX_BYTES`、`LOG_MESSAGE_MODE=preview|hash`（默认 `hash`）。

### 2.5 优雅退出（E4）

`server/src/index.ts`：

- 注册 `SIGTERM` / `SIGINT`（防重入）：
  1. log `shutting down`；
  2. `await app.close()`；
  3. `await logStore.flush()`；
  4. `process.exit(0)`；
- 超时保护：8s 内未完成则 `process.exit(1)`。
- 启动日志可提示 shutdown 已挂载。

### 2.6 前端 SSE（P1）

`web/src/api/client.ts`：

- 新增 `sendChatStream(message, sessionId, handlers)`：
  - `POST /api/chat/stream`，`content-type: application/json`；
  - 用 `fetch` + `ReadableStream` 解析 SSE（`event:`/`data:`）；
  - handlers：`onMeta`、`onDelta`、`onDone`；
  - 失败或非 200 → throw，由 App 回退。
- 保留 `sendChat` 作为回退。

`web/src/App.tsx` `handleSend`：

1. 追加 user 气泡 + 占位 assistant 气泡（`streaming: true`，text 逐步增长）；
2. 优先 `sendChatStream`；`onDelta` 更新该气泡文本；
3. `done` 后写入完整 answer/sources，`speak(full)`；
4. **任何流错误**（网络、非 SSE、提前断开）→ 删除半截气泡，调用 `sendChat` 非流式，成功则替换/追加完整气泡并 TTS；
5. busy 语义不变；打断/重置时 abort stream（`AbortController`）。

UI：流式气泡与现有样式一致；busy 时显示「正在生成回答…」，首个 delta 到达后可改为实时文本。

### 2.7 文档与配置

- `server/.env.example`：`HOST=127.0.0.1`、`REQUIRE_ADMIN_TOKEN`、`LOG_MAX_BYTES`、`LOG_MESSAGE_MODE`、`NODE_ENV` 说明。
- `docs/deployment.md`、`docs/api.md`：安全默认、错误信封、SSE 字段、requestId。
- `CHANGELOG.md`：0.7.0 Phase A。
- `plan.md` Phase A 勾选（交付时）。

### 2.8 测试边界

- 单测（`server/scripts/unit.test.ts` 扩展）：
  - `adminOk` requireToken 矩阵；
  - JsonlStore preview/hash 与 rotate（tmpdir）；
  - HybridRetriever generation 递增 + replace 后 list 变化（用内存 mock embedder/空向量）；
  - `runChat` 在 mock 模型下返回与 sessions/analytics 可观察副作用（可用轻量 deps mock）。
- API 审计：保留 20 项；**新增**（或改写）：
  - 500 信封不含 stack（可选，若难以人为触发则单测覆盖）；
  - SSE 流事件序列 meta→delta→done；
  - 本地默认 admin 开放（NODE_ENV 空）时 reload 200；
  - 文档说明生产 401 路径（脚本以 `REQUIRE_ADMIN_TOKEN=1` 且无 token 启动的检查可选，若时间不够则单测覆盖 adminOk）。
- 前端：build 通过；人工/脚本确认 stream 回退逻辑存在（单测不强制）。

## [S3] Out of Scope

- Phase B：真实 Embedding/LLM 接入、检索评测集、同义词迭代、cache key 含索引版本（K3 可顺带做但不作为本特性验收门）。
- Phase C：展览 zone 闭环、feedback 报表、PDF 入库、VRM。
- Redis 限流、HTTPS 证书落地、跨进程 session 持久化（E5）、watch 稳定化（E9 文档标注即可）。
- 不引入新 ORM/框架依赖（SSE 用原生 fetch stream）。

## Tasks

- [x] T1: Spec 落盘本文件 — acceptance: status 可按阶段更新，契约完整 (covers: S1, S2)
- [x] T2: S1+S2 默认 HOST 与 ADMIN_TOKEN 强制 — acceptance: 代码默认 127.0.0.1；`REQUIRE_ADMIN_TOKEN=1` 且无 token 时 stats/reload 401；.env.example/deployment 更新 (covers: S2.1)
- [x] T3: S3 错误脱敏 + requestId — acceptance: chat/knowledge/SSE 失败响应无堆栈/路径；body 含 error/message/requestId (covers: S2.1)
- [x] T4: E1 抽取 runChat/streamChat，chat 与 SSE 共用 — acceptance: routes 无重复检索/会话/日志逻辑；单测可测 runChat (covers: S2.2)
- [x] T5: E2 retriever generation + 原子 replace + VectorStore 临时构建 — acceptance: reload 后 generation+1；list/retrieve 读同一快照 (covers: S2.3)
- [x] T6: E3 日志脱敏 + 轮转 + flush — acceptance: events 无完整长 message（默认 hash）；超 maxBytes 轮转；flush 可 await (covers: S2.4)
- [x] T7: E4 SIGTERM/SIGINT 优雅退出 — acceptance: 可 close app 并 flush 日志后 exit；防重入 (covers: S2.5)
- [x] T8: P1 前端 SSE 流式 + 非流式回退 — acceptance: delta 流式渲染；失败回退 sendChat；TTS 用全文 (covers: S2.6)
- [x] T9: 单测扩展 + api-audit 兼容 + 文档/CHANGELOG — acceptance: unit 全绿；audit 不回归；docs 已改 (covers: S2.1–S2.7)
- [x] T10: 全量回归 build + unit + api-audit — acceptance: server/web build PASS；unit PASS；audit 全绿 (covers: S2)
