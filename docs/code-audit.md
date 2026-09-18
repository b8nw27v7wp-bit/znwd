# 代码审计与功能测试报告

> 最近更新：2026-09-18（第二轮加固后）
> 范围：当前仓库静态排查 + 对抗性探测 + 本地 API 冒烟。实现细节以代码为准。

## 第二轮基线（0.9.0）

| 项 | 结果 |
|----|------|
| 单元测试 `npm test -w server` | **32/32 PASS** |
| API 审计 `node server/scripts/api-audit.mjs` | **34/34 PASS** |
| 检索评测 `npm run eval:retrieval` | top1 **0.9667** / top3 **1.00**；闸门漏答 **0** |
| 相关性标定 `npm run calibrate -w server` | 域外最高 2.64 < 阈值 3.8 < 在域最低 5.05 |
| 构建 `npm run build` | server + web PASS |
| 闸门实测（/api/chat 直连） | 域内 6/6 正常作答；域外 10/10 判为未覆盖 |

### 实测发现与处置

| # | 问题 | 证据 | 处置 |
|---|------|------|------|
| 1 | 非字符串入参打成 500 | `{"message":12345}` → 500 internal_error（`(body.message ?? '').trim()` 抛 TypeError） | `http/request.ts` 统一解析 → 400 `validation_error` |
| 2 | CORS 任意源放行 | 带 `Origin: https://evil.example` 请求，ACAO 原样回显该源，预检 204 放行；SSE 另手写 `*` | `http/cors.ts` 白名单策略，HTTP/SSE 同一口径 |
| 3 | 404/405 绕过统一信封 | `GET /api/nope` → Fastify 默认体（`statusCode`、无 requestId） | `setNotFoundHandler` → `not_found` 信封 |
| 4 | 检索永远有命中 | 「今天上海天气怎么样？」→ `mode=rag`、4 条风场资料、答「根据展厅资料」 | 相关性闸门 + 无命中专用 system 指令 |
| 5 | 单字命中污染打分 | 阈值标定显示域外最高分 2.46 > 部分在域问题 | 分词改 bigram-only + IDF 加权 |
| 6 | 检索模式写死 hybrid | `stats().mode` 与 `RagAnswer.retrieval` 恒为 `hybrid`，bag 兜底时也在说谎 | 按实际参与上报，附 `semantic`/`degradedReason`/`thresholds` |
| 7 | SSE 回答不进缓存 | 流式问完再非流式问仍重跑 | 两入口共用缓存读写 |
| 8 | SSE 无反代友好处理 | 无 `x-accel-buffering`、无心跳 | 补头 + 15s 心跳 + 断开即停 |
| 9 | 审计脚本硬编码绝对路径 | `E:/znwd/server/data/events.jsonl`，换机即 FAIL | 改为脚本相对路径 + `AUDIT_BASE` |
| 10 | 文档与代码互相打脸 | CHANGELOG 0.2.2 声称删除形象区技术提示，代码里仍在；code-audit 写 17/17 与 CHANGELOG 的 19/19 不一致 | 代码对齐声明，本文与 CHANGELOG 同步更新 |
| 11 | 反馈闭环缺前端 | 服务端有 `/api/feedback` + 统计 + CSV，前端无入口 | 助手气泡加「有帮助 / 没帮助」 |
| 12 | 分块器不适应长文档 | 6 篇 md 全部 < 500 字 → 每篇 1 块，切分/重叠逻辑从未被真实长文考验 | 标题感知分块 + 超长段落滑窗重叠，并补单测 |

### 本轮引入并已修复的自身缺陷（记录备查）

- 客户端断开检测写成 `req.raw.on('close')`：该事件在请求体读完即触发，导致 SSE 首事件后 break 且不 `end`，连接挂死。改为监听 `reply.raw` 的 `close` 并用 `writableEnded` 判定。

---

（以下为 0.8.0 及更早的历史审计正文，部分结论已被本轮取代，保留作对照。）

## 历史基线（Phase A，0.8.0）

**Phase A 之后的基线**：`npm test -w server` **17/17**；`node server/scripts/api-audit.mjs` **20/20**；前端已接 **SSE**（失败回退 POST）；`HOST` 默认 `127.0.0.1`；生产强制 `ADMIN_TOKEN`；错误信封脱敏；chat/SSE 共用 `runChat`/`streamChat`。

（以下为 Phase A 之前的历史审计正文，部分结论已过时，保留作对照。）

日期：2026-09-17  
范围：`server/`（Hybrid RAG、会话、缓存、流式、管理接口）+ `web/` 关键路径  
方法：静态阅读 + `npm test -w server` + `server/scripts/api-audit.mjs` 功能套件

## 结论

| 项 | 结果 |
|----|------|
| 单元测试 | **10/10 PASS** |
| API 功能测试 | **20/20 PASS** |
| server / web 构建 | PASS |
| Critical | 已修复（见下） |

## 审计发现与处置

### Critical / 已修复

| 问题 | 位置 | 处置 |
|------|------|------|
| `model.stream(messages)` 参数类型错误，流式必炸 | `rag/pipeline.ts` | 改为 `stream({ messages })` |
| 答案缓存命中**不写入会话**，后续追问丢失上下文 | `routes/chat.ts` | 命中时仍 `sessions.append` + 记 stats |
| knowledge reload 未清空答案缓存，可能返回旧资料答案 | `index.ts` / `routes/knowledge.ts` | `onReloaded` → `answerCache.clear()` |
| feedback `rating` 收窄失败导致 **tsc 构建失败** | `routes/chat.ts` | 收敛为 `'up' \| 'down'` |

### Major（可接受 / 已文档化）

| 问题 | 说明 |
|------|------|
| `ADMIN_TOKEN` 未配置时管理接口开放 | 展厅内网默认；生产必须配置 |
| Mock/`bag` 非语义向量与生成式模型 | 接入 `openai_compat` 后覆盖 |
| 会话/统计内存态 | 进程重启清空；JSONL 已落盘 `server/data/events.jsonl` |
| SSE 与 POST `/api/chat` 共享限流桶 | 防刷优先，合理 |
| `watch(knowledge, {recursive})` | 需 Node 较新版本与 OS 支持；默认 `KNOWLEDGE_WATCH=false` |

### Minor

- `grounded.ts` 删除未使用函数  
- 前端仍用非流式 `/api/chat`（接口已就绪，后续可接 SSE）  
- rate-limit map 超限按插入序淘汰，非严格 LRU（展厅可接受）  
- JSONL 写失败静默（主流程不阻断）

## 功能覆盖（API 套件）

- health / zones / suggestions(?zone)  
- chat 400 空消息  
- 光伏 / 风场知识命中（rag + sources）  
- 同义词扩展：「太阳能组件清洗」→ 光伏清洁文档  
- 答案缓存命中 + **缓存命中写入会话**  
- 多轮会话 history  
- feedback 成功/校验失败  
- stats 计数  
- SSE stream（meta/delta/done）  
- knowledge list/reload、openapi.json  
- session delete + 404  
- JSONL 日志落盘  

## 复现命令

```bash
npm run build -w server && npm run build -w web
npm test -w server
# 终端 A
npm run dev:server
# 终端 B
node server/scripts/api-audit.mjs
```

## 本阶段新增后端能力（与审计一并交付）

- 答案 LRU 缓存（`ANSWER_CACHE_SIZE`）  
- 问答/反馈 JSONL（`server/data/`）  
- 领域同义词扩展检索  
- Mock 基于检索片段的 grounded 回答  
- `POST /api/chat/stream` SSE  
- `GET /api/openapi.json`  
- 可选 `ADMIN_TOKEN`、`KNOWLEDGE_WATCH`  
- 单元测试与 API 审计脚本  
