# HTTP API

产品展厅 AI 虚拟讲解（光伏清洁无人机 / 风场检测无人机）。

Base URL：开发态经 Vite 代理为 `http://localhost:5173`；直连后端为 `http://127.0.0.1:8787`。

所有 JSON 响应 `Content-Type: application/json`。

---

## GET /api/health

健康检查与运行参数摘要。

**200 示例**

```json
{
  "ok": true,
  "knowledgeChunks": 23,
  "llmProvider": "mock",
  "embedding": "bag",
  "retrieval": {
    "mode": "keyword",
    "semantic": false,
    "degradedReason": "EMBED_PROVIDER=bag（特征哈希，非语义向量）",
    "thresholds": { "minKeywordScore": 3.8, "minVectorScore": 0.35 },
    "generation": 1
  },
  "corsOrigins": [],
  "minRelevanceScore": 3.8,
  "knowledgeDir": "E:/znwd/knowledge",
  "activeSessions": 0,
  "uptimeSec": 12
}
```

| 字段 | 说明 |
|------|------|
| `knowledgeChunks` | 当前索引中的知识块数量 |
| `llmProvider` | `mock` \| `openai_compat` 等实现名 |
| `retrieval.mode` | **如实上报**：仅当向量路具备语义能力且真的参与融合才是 `hybrid`，否则 `keyword` |
| `retrieval.semantic` / `degradedReason` | 向量路是否语义向量；降级原因（如 bag 兜底） |
| `retrieval.thresholds` | 相关性闸门当前阈值 |
| `corsOrigins` | 配置的 CORS 白名单（空 = 仅本地开发源） |
| `knowledgeDir` | 实际知识目录绝对路径 |
| `activeSessions` | 未过期内存会话数 |
| `uptimeSec` | 进程运行秒数 |

---

## GET /api/suggestions

`?zone=` 可选：`zoneId` 或 `mediaId`（来自 `knowledge/_meta/zones.json`）。不传返回全馆汇总推荐。

**200 示例**

```json
{
  "items": ["光伏清洁无人机是做什么的？", "清洁作业流程是怎样的？", "光伏展区展示什么？"],
  "zone": "pv-clean"
}
```

`zone` 示例：`pv-clean`、`wind-inspect`、`service`、`safety`，或媒体 ID `exhibit-pv-clean` / `exhibit-wind-inspect`。

---

## GET /api/zones

返回展览分区与媒体映射（`zones.json`）。

---

## POST /api/chat

问答主接口（**Hybrid RAG**：关键词 + 向量 RRF）。携带同一 `sessionId` 可保留最近多轮上下文。

**请求**

```json
{
  "message": "参观需要预约吗",
  "sessionId": "s-abc123"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 用户问题；非字符串 / 空串 / 空 body 一律 400；服务端截断至 2000 字符 |
| `sessionId` | string | 否 | 会话 ID（只保留 `A-Za-z0-9._-`，≤64 字符）；同 ID 多轮上下文；缺省则单轮 |

**成功 200**

```json
{
  "answer": "……",
  "sources": [
    {
      "title": "光伏清洁无人机产品概述",
      "snippet": "……",
      "score": 0.0162,
      "sourcePath": "01_光伏清洁无人机\\产品概述.md"
    }
  ],
  "mode": "rag",
  "provider": "mock",
  "retrieval": "keyword",
  "noHit": false,
  "sessionId": "optional-id",
  "latencyMs": 3,
  "cached": false
}
```

| 字段 | 说明 |
|------|------|
| `answer` | 模型回复正文（前端用于气泡与 TTS） |
| `sources` | 检索命中；含 `zone`/`zoneTitle`/`keywordScore`/`vectorScore` |
| `mode` | `rag` 有命中；`llm_only` 未命中 |
| `retrieval` | `hybrid`（语义向量参与）或 `keyword`，**如实反映** |
| `noHit` | `true` = 相关性闸门未通过（知识库未覆盖），本次回答没有任何知识片段支撑 |
| `rewrite` | 多轮指代改写：`{ rewritten, reason, carriedTokens }`；`reason=none/no_history/prev_weak/ellipsis_merged`。检索用改写后的查询，回答仍按原问题 |
| `cached` | 是否命中答案缓存（缓存 key 含 model + 索引 generation + message） |

**相关性闸门**

关键词分 < `MIN_RELEVANCE_SCORE`（且语义向量路不可用或余弦 < `MIN_VECTOR_SCORE`）时：
`sources` 为空、`mode=llm_only`、`noHit=true`，system 提示改为「未检索到，直接说明资料中没有」。
阈值用 `npm run calibrate -w server` 在现有知识库上标定（改知识或同义词后应重跑）。

**错误信封（Phase A + 本轮）**

统一字段：

```json
{ "error": "validation_error", "message": "消息说明", "requestId": "req-id" }
```

| 状态码 | 条件 | `error` 码 |
|--------|------|------------|
| 400 | `message` 缺失/空白/非字符串、参数非法 | `validation_error` |
| 401 | 管理接口未授权（生产强制 `ADMIN_TOKEN`） | `unauthorized` |
| 404 | 未知路由或方法（含 Fastify 默认 404 已收敛） | `not_found` |
| 429 | 超过 `CHAT_RATE_PER_MIN`（附 `retryAfterSec`） | `rate_limited` |
| 500 | LLM/内部异常 | `internal_error`（`message` 固定为「服务内部错误」，细节只进服务端日志） |

成功响应额外字段：`latencyMs`（服务端耗时毫秒）。

**CORS**

默认只放行 `localhost` / `127.0.0.1` / `[::1]`（任意端口）。生产用 `CORS_ORIGINS` 显式配置白名单
（逗号分隔，支持 `*`），未命中的 Origin 不回 `access-control-allow-origin`，SSE 走同一策略。

---

## GET /api/sessions/:sessionId

查看会话历史（只读，不刷新 TTL）。过期或不存在 → 404。

**200**

```json
{
  "sessionId": "s-abc",
  "messages": [
    { "role": "user", "content": "…" },
    { "role": "assistant", "content": "…" }
  ],
  "lastActive": 1710000000000
}
```

---

## DELETE /api/sessions/:sessionId

删除会话（前端「重置」可选用）。

**200**：`{ "ok": true, "sessionId": "…" }`

---

## POST /api/feedback

回答点赞/点踩，计入统计。

**请求**

```json
{ "sessionId": "optional", "rating": "up", "comment": "optional", "question": "optional 上一问摘要" }
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `rating` | 是 | `up` \| `down`，否则 400 |
| `sessionId` | 否 | 关联会话 |
| `comment` | 否 | ≤500 字 |
| `question` | 否 | ≤200 字；**缺省时服务端自动取该会话最后一条用户提问**，保证运营看到的是真实问题 |

**200**：`{ "ok": true }`

前端：助手回答下方「有帮助 / 没帮助」按钮即调用本接口；请求失败会回滚本地标记。

---

## GET /api/admin/feedback-stats

负反馈汇总（管理接口，鉴权规则同 `/api/stats`）。

- 默认 JSON：
  ```json
  {
    "total": 4, "up": 3, "down": 1, "downRate": 0.25,
    "topDown": [{ "question": "叶片检测要停机吗？", "down": 1, "comments": [] }],
    "recent": [{ "at": 0, "sessionId": "s-1", "rating": "up", "question": "提供培训吗？", "comment": null }],
    "recentDown": [{ "at": 0, "sessionId": "s-2", "question": "…", "comment": null }]
  }
  ```
- `?format=csv`：`text/csv` 附件 `feedback.csv`

---
## GET /api/stats

运行统计（内存态，进程重启清零）。

**200 示例（节选）**

```json
{
  "uptimeSec": 60,
  "chatTotal": 2,
  "ragHits": 1,
  "llmOnly": 1,
  "noHit": 1,
  "errors": 0,
  "activeSessions": 1,
  "feedback": { "up": 1, "down": 0 },
  "recent": [ { "at": 0, "mode": "rag", "noHit": false, "messagePreview": "…", "latencyMs": 2 } ]
}
```

| 字段 | 说明 |
|------|------|
| `noHit` | 知识库未覆盖（闸门拦截）次数——这类问题就是下一批要补的资料 |
| `rewritten` | 多轮指代改写生效次数（追问场景占比） |
| `uncoveredCount` | 已留存的未覆盖问题条数（明细见 `/api/admin/uncovered`） |

---

## GET /api/knowledge/list

列出知识库文件与分块统计。

**200**

```json
{
  "knowledgeDir": "…/knowledge",
  "fileCount": 3,
  "chunkCount": 3,
  "docs": [
    { "path": "参观接待流程.md", "bytes": 512, "mtime": "…", "chunks": 1, "title": "参观接待流程" }
  ]
}
```

---

## GET /api/admin/uncovered

知识库未覆盖的问题清单（`noHit` 的原始提问，明文、内存态、限量），供运营补资料。

- 200：`{ "count": 2, "items": [ { "at": 0, "sessionId": "s-1", "question": "会议室在哪里" } ] }`（新→旧）
- 鉴权同 `/api/stats`；留存条数由 `UNCOVERED_LOG_SIZE` 控制（0 = 关闭）
- `PERSIST_STATE=true` 时随状态落盘，重启不丢

---

## POST /api/knowledge/reload

重新扫描 `KNOWLEDGE_DIR` 并替换内存索引。热更新知识文档后调用（或重启 server）。

**200 示例**

```json
{
  "ok": true,
  "knowledgeChunks": 3,
  "files": [{ "sourcePath": "参观接待流程.md", "chunks": 1 }]
}
```

---

## POST /api/chat/stream

SSE 流式问答。请求体同 `/api/chat`。

事件：

- `event: meta` → `{ mode, sources, provider, noHit, retrieval, sessionId }`
- `event: delta` → `{ text }`
- `event: done` → `{ latencyMs, answer, sources, mode, noHit, retrieval, cached }`
- `event: error` → `{ error, message, requestId }`（不泄露堆栈）

连接行为：

- 响应头含 `x-accel-buffering: no`（nginx/Caddy 不缓冲），每 15s 发一次 `: ping` 注释心跳；
- 客户端断开即停止生成，不再继续写响应；
- 与非流式**共用答案缓存**：流式问过的单轮问题，再走 `POST /api/chat` 会命中 `cached: true`。

前端 `web/src/api/client.ts` 优先 SSE（`meta` 到达即渲染来源与「未覆盖」提示）；失败自动回退 `POST /api/chat`。

---

## 管理与其它

| 接口 | 说明 |
|------|------|
| `GET /api/stats` | 配置了 `ADMIN_TOKEN` 时需 `Authorization: Bearer <token>`；`NODE_ENV=production|prod|staging` 或 `REQUIRE_ADMIN_TOKEN=true` 时**未配置 token 即 401** |
| `POST /api/knowledge/reload` | 同上；响应含 `generation`（索引代数） |
| `GET /api/openapi.json` | API 契约（含 components schemas：ChatRequest / ChatResponse / Source / Error） |

环境变量补充：`HOST`、`ADMIN_TOKEN`、`REQUIRE_ADMIN_TOKEN`、`CORS_ORIGINS`、`ANSWER_CACHE_SIZE`、`MIN_RELEVANCE_SCORE`、`MIN_VECTOR_SCORE`、`DATA_DIR`、`KNOWLEDGE_WATCH`、`LOG_MAX_BYTES`、`LOG_MESSAGE_MODE`。

---

## 环境变量（server）

见 `server/.env.example`：

| 变量 | 默认 | 说明 |
|------|------|------|
| `LLM_PROVIDER` | `mock` | `mock` \| `openai_compat` |
| `LLM_BASE_URL` | 空 | OpenAI 兼容根路径，如 `https://gw/v1` |
| `LLM_API_KEY` | 空 | Bearer |
| `LLM_MODEL` | 空 | 模型名 |
| `KNOWLEDGE_DIR` | `./knowledge` | 相对仓库根 |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | **Phase A 默认仅本机**；跨机需显式配置并限制防火墙/反代 |
| `CORS_ORIGINS` | 空 | 逗号分隔白名单；空 = 仅本地开发源。生产必填 |
| `MIN_RELEVANCE_SCORE` | `3.8` | 关键词分闸门（`npm run calibrate -w server` 标定） |
| `MIN_VECTOR_SCORE` | `0.35` | 语义向量兜底的最低余弦 |
| `UNCOVERED_LOG_SIZE` | `50` | noHit 原始提问留存条数（0 = 关闭） |
| `PERSIST_STATE` | `false` | 状态落盘 `DATA_DIR/state.json`，重启恢复会话/计数/反馈/未覆盖清单 |
| `PERSIST_INTERVAL_SEC` | `60` | 定时落盘间隔（下限 10s）；退出时也会落盘 |
| `ADMIN_TOKEN` | 空 | 管理接口 Bearer；生产必须设置 |
| `REQUIRE_ADMIN_TOKEN` | 空 | `true` 时无 token 管理接口 401 |
| `NODE_ENV` | 空 | `production`/`prod`/`staging` 时强制管理口令 |
| `CHAT_RATE_PER_MIN` | `30` | 每 IP 每分钟 chat 上限 |
| `EMBED_PROVIDER` | `bag` | `bag` \| `openai_compat` |
| `EMBED_BASE_URL` | 可回落 `LLM_BASE_URL` | embeddings 接口 |
| `EMBED_MODEL` | 空 | 向量模型名（openai_compat 必填） |
| `INDEX_DIR` | `./server/indexes` | 向量索引目录 |
| `LOG_MAX_BYTES` | `5000000` | events.jsonl 轮转阈值 |
| `LOG_MESSAGE_MODE` | `hash` | `hash` \| `preview`；JSONL 不再落盘完整 question |
| 答案缓存 key | — | 含 model + **retriever generation** + message（reload 后不串代） |

---

## curl 示例

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s http://127.0.0.1:8787/api/stats
curl -s http://127.0.0.1:8787/api/knowledge/list

curl -s -X POST http://127.0.0.1:8787/api/chat \
  -H "content-type: application/json" \
  -d "{\"message\":\"能否现场参观？\",\"sessionId\":\"demo\"}"

curl -s -X POST http://127.0.0.1:8787/api/feedback \
  -H "content-type: application/json" \
  -d "{\"sessionId\":\"demo\",\"rating\":\"up\"}"

curl -s -X POST http://127.0.0.1:8787/api/knowledge/reload
```
