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
  "knowledgeChunks": 3,
  "llmProvider": "mock",
  "knowledgeDir": "E:/znwd/knowledge",
  "activeSessions": 0,
  "uptimeSec": 12
}
```

| 字段 | 说明 |
|------|------|
| `knowledgeChunks` | 当前索引中的知识块数量 |
| `llmProvider` | `mock` \| `openai_compat` 等实现名 |
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
| `message` | string | 是 | 用户问题；空串 400；服务端截断至 2000 字符 |
| `sessionId` | string | 否 | 会话 ID（≤64 字符）；同 ID 多轮上下文；缺省则单轮 |

**成功 200**

```json
{
  "answer": "……",
  "sources": [
    {
      "title": "参观接待流程",
      "snippet": "……",
      "score": 3.5325,
      "sourcePath": "参观接待流程.md"
    }
  ],
  "mode": "rag",
  "provider": "mock",
  "retrieval": "hybrid",
  "sessionId": "optional-id",
  "latencyMs": 3
}
```

| 字段 | 说明 |
|------|------|
| `answer` | 模型回复正文（前端用于气泡与 TTS） |
| `sources` | 检索命中；含 `zone`/`zoneTitle`/`keywordScore`/`vectorScore` |
| `mode` | `rag` 有命中；`llm_only` 无命中仍生成 |
| `provider` | 实际使用的 LLM 实现名 |
| `retrieval` | 当前为 `hybrid` |

**错误信封（Phase A）**

统一字段：

```json
{ "error": "validation_error", "message": "消息说明", "requestId": "req-id" }
```

| 状态码 | 条件 | `error` 码 |
|--------|------|------------|
| 400 | 缺省或空白 `message` / 参数非法 | `validation_error` |
| 401 | 管理接口未授权（生产强制 `ADMIN_TOKEN`） | `unauthorized` |
| 429 | 超过 `CHAT_RATE_PER_MIN`（附 `retryAfterSec`） | `rate_limited` |
| 500 | LLM/内部异常 | `internal_error`（`message` 固定为「服务内部错误」，细节只进服务端日志） |

成功响应额外字段：`latencyMs`（服务端耗时毫秒）。

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
| `question` | 否 | ≤200 字，供负反馈运营分析 |

**200**：`{ "ok": true }`

---

## GET /api/admin/feedback-stats

负反馈汇总（管理接口，鉴权规则同 `/api/stats`）。

- 默认 JSON：`{ total, up, down, downRate, topDown[], recentDown[] }`
- `?format=csv`：`text/csv` 附件 `feedback.csv`

---
## GET /api/stats

运行统计（内存态，进程重启清零）。

**200 示例（节选）**

```json
{
  "uptimeSec": 60,
  "chatTotal": 2,
  "ragHits": 2,
  "llmOnly": 0,
  "errors": 0,
  "activeSessions": 1,
  "feedback": { "up": 1, "down": 0 },
  "recent": [ { "at": 0, "mode": "rag", "messagePreview": "…", "latencyMs": 2 } ]
}
```

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

- `event: meta` → `{ mode, sources, provider, sessionId }`
- `event: delta` → `{ text }`
- `event: done` → `{ latencyMs, answer, sources, mode }`
- `event: error` → `{ error, message, requestId }`（不泄露堆栈）

前端 `web/src/api/client.ts` 优先 SSE；失败自动回退 `POST /api/chat`。

---

## 管理与其它

| 接口 | 说明 |
|------|------|
| `GET /api/stats` | 配置了 `ADMIN_TOKEN` 时需 `Authorization: Bearer <token>`；`NODE_ENV=production|prod|staging` 或 `REQUIRE_ADMIN_TOKEN=true` 时**未配置 token 即 401** |
| `POST /api/knowledge/reload` | 同上；响应含 `generation`（索引代数） |
| `GET /api/openapi.json` | 简易 API 清单 |

环境变量补充：`HOST`、`ADMIN_TOKEN`、`REQUIRE_ADMIN_TOKEN`、`ANSWER_CACHE_SIZE`、`DATA_DIR`、`KNOWLEDGE_WATCH`、`LOG_MAX_BYTES`、`LOG_MESSAGE_MODE`。

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
