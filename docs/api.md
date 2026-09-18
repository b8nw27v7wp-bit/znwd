# HTTP API

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
  "knowledgeDir": "E:/znwd/knowledge"
}
```

| 字段 | 说明 |
|------|------|
| `knowledgeChunks` | 当前索引中的知识块数量 |
| `llmProvider` | `mock` \| `openai_compat` 等实现名 |
| `knowledgeDir` | 实际知识目录绝对路径 |

---

## POST /api/chat

问答主接口。

**请求**

```json
{
  "message": "参观需要预约吗",
  "sessionId": "optional-id"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 用户问题；空串 400；服务端截断至 2000 字符 |
| `sessionId` | string | 否 | 透传回响应，便于前端关联会话 |

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
  "sessionId": "optional-id"
}
```

| 字段 | 说明 |
|------|------|
| `answer` | 模型回复正文（前端用于气泡与 TTS） |
| `sources` | 检索命中；`mode=llm_only` 时通常为空 |
| `mode` | `rag` 有命中；`llm_only` 无命中仍生成 |
| `provider` | 实际使用的 LLM 实现名 |

**错误**

| 状态码 | 条件 | 响应体 |
|--------|------|--------|
| 400 | 缺省或空白 `message` | `{ "error": "message is required" }` |
| 500 | LLM/内部异常 | `{ "error": "<message>" }` |

---

## POST /api/knowledge/reload

重新扫描 `KNOWLEDGE_DIR` 并替换内存索引。热更新知识文档后调用（或重启 server）。

**200 示例**

```json
{ "ok": true, "knowledgeChunks": 5 }
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

---

## curl 示例

```bash
curl -s http://127.0.0.1:8787/api/health

curl -s -X POST http://127.0.0.1:8787/api/chat \
  -H "content-type: application/json" \
  -d "{\"message\":\"能否现场参观？\"}"

curl -s -X POST http://127.0.0.1:8787/api/knowledge/reload
```
