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

**错误**

| 状态码 | 条件 | 响应体 |
|--------|------|--------|
| 400 | 缺省或空白 `message` | `{ "error": "message is required" }` |
| 500 | LLM/内部异常 | `{ "error": "<message>" }` |
| 429 | 超过 `CHAT_RATE_PER_MIN` | `{ "error": "too many requests", "retryAfterSec": n }` |

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
{ "sessionId": "optional", "rating": "up", "comment": "optional" }
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `rating` | 是 | `up` \| `down`，否则 400 |
| `sessionId` | 否 | 关联会话 |
| `comment` | 否 | ≤500 字 |

**200**：`{ "ok": true }`

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
| `HOST` | `0.0.0.0` | 监听地址；展厅本机可用 `127.0.0.1` |
| `CHAT_RATE_PER_MIN` | `30` | 每 IP 每分钟 chat 上限 |
| `EMBED_PROVIDER` | `bag` | `bag` \| `openai_compat` |
| `EMBED_BASE_URL` | 可回落 `LLM_BASE_URL` | embeddings 接口 |
| `EMBED_MODEL` | 空 | 向量模型名（openai_compat 必填） |
| `INDEX_DIR` | `./server/indexes` | 向量索引目录 |

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
