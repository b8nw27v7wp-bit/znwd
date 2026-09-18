# 系统架构

产品展厅 AI 虚拟讲解：**光伏清洁无人机 / 风场检测无人机**。

## 总览

```
参观人员
   │
   ▼
┌──────────────────────────────────────────────┐
│  web/  浏览器大屏                             │
│  ┌──────────────┐  ┌──────────────────────┐  │
│  │ 仅左 1/3     │  │ 右侧 2/3 留白        │  │
│  │ ┌──────────┐ │  │ （可挂展览播放）     │  │
│  │ │ 虚拟形象  │ │  │                      │  │
│  │ ├──────────┤ │  │                      │  │
│  │ │ 对话输入  │ │  │                      │  │
│  │ └────┬─────┘ │  │                      │  │
│  └──────┼───────┘  └──────────────────────┘  │
│         │ TTS + POST /api/chat (Vite 代理)   │
└─────────┼────────────────────────────────────┘
          ▼
┌──────────────────────────────────────────────┐
│  server/  Fastify                            │
│  Hybrid RAG: keyword + embedding (RRF)       │
│  knowledge/  01_光伏 / 02_风场 / 03_服务 / 90_通识 │
│  LLM: mock | openai_compat                   │
└──────────────────────────────────────────────┘
```

## 技术选型

| 层 | 选型 | 原因 |
|----|------|------|
| 前端 | Vite + React + TS | 展厅网页、同仓 TS |
| 后端 | Fastify + TS (ESM) | 轻量 API |
| 检索 | Hybrid：关键词（bigram+IDF）+ 语义向量 RRF，附相关性闸门 | 离线可用，可升内网 embeddings；闸门保证「不知道就说不知道」 |
| 向量 | JSON 索引 + bag/openai_compat（`semantic` 标记） | 零外部服务；bag 兜底时如实上报 keyword |
| LLM | 可插拔 ChatModel | mock / 内网网关 |
| 语音 | speechSynthesis | 先跑通朗读链路 |
| 形象 | CSS 占位，可换 Live2D | 无模型也可演示，界面不暴露技术提示 |

## 模块边界（server）

| 路径 | 职责 |
|------|------|
| `src/index.ts` | 启动、装配 HybridRetriever / CORS 策略 / 统一 404 与错误信封 / 路由 |
| `src/http/cors.ts` | CORS 白名单策略（HTTP 与 SSE 共用） |
| `src/http/request.ts` | 入参解析与会话 ID 规范化（所有非法入参收敛为 400） |
| `src/knowledge/loader.ts` | 分区知识 + frontmatter + zones.json + 标题感知分块 |
| `src/knowledge/retriever.ts` | 关键词路（bigram + IDF + 标题加权） |
| `src/knowledge/vectorStore.ts` | 向量索引（指纹防陈旧、语义能力标记） |
| `src/knowledge/hybridRetriever.ts` | RRF 融合 + **相关性闸门** + 如实上报检索模式 |
| `src/embedding/*` | bag / openai_compat（`semantic` 标记决定 mode 能否为 hybrid） |
| `src/rag/pipeline.ts` | Prompt + 调 LLM（无命中时改为「直说没有」指令） |
| `src/rag/runChat.ts` | 非流式/流式共用链路：会话、缓存、统计、日志 |
| `src/routes/chat.ts` | chat / SSE / sessions / suggestions / zones / feedback / stats / openapi |
| `src/routes/knowledge.ts` | list / reload |
| `src/session|analytics|http/*` | 会话、统计（含 `noHit`）、限流、日志 |

## 数据流

1. 输入 → `POST /api/chat`（或 SSE `/api/chat/stream`）+ `sessionId`
2. `parseChatInput` 校验与规范化（非法 → 400，不再 500）
3. SessionStore 取最近历史
4. Hybrid 检索 `knowledge/`：关键词路打分 → **闸门**判断是否达标 →（可选）向量路 RRF 融合
5. 达标：命中片段进入 system → LLM；未达标：不喂任何片段，system 改为「直说资料中没有」
6. 写回会话；返回 answer/sources/mode/**noHit**/retrieval/latencyMs（流式另有 meta/delta/done）
7. 前端气泡 + TTS + 反馈按钮；命中闸门时展开推荐问法；展览播放可 `GET /api/suggestions?zone=`

## 非目标（当前）

STT、生产鉴权、集群、向量库服务、STT/CRM 对接。详见 [code-review.md](./code-review.md)。
