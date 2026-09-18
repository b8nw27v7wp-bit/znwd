# 代码审计与功能测试报告

> 最近更新：2026-09-17（Phase A 合入后补记）  
> 范围：当前仓库静态排查 + 本地 API 冒烟。实现细节以代码为准。

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
