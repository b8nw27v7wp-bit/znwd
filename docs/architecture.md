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
| 检索 | Hybrid：关键词 + 本地向量 RRF | 离线可用，可升内网 embeddings |
| 向量 | JSON 索引 + bag/openai_compat | 零外部服务 |
| LLM | 可插拔 ChatModel | mock / 内网网关 |
| 语音 | speechSynthesis | 先跑通朗读链路 |
| 形象 | CSS 占位，可换 Live2D | 无模型也可演示 |

## 模块边界（server）

| 路径 | 职责 |
|------|------|
| `src/index.ts` | 启动、装配 HybridRetriever / 路由 |
| `src/knowledge/loader.ts` | 分区知识 + frontmatter + zones.json |
| `src/knowledge/retriever.ts` | 关键词路 |
| `src/knowledge/vectorStore.ts` | 向量索引（指纹防陈旧） |
| `src/knowledge/hybridRetriever.ts` | RRF 融合 |
| `src/embedding/*` | bag / openai_compat |
| `src/rag/pipeline.ts` | Prompt + 调 LLM |
| `src/routes/chat.ts` | chat / sessions / suggestions / zones / feedback / stats |
| `src/routes/knowledge.ts` | list / reload |
| `src/session|analytics|http/*` | 会话、统计、限流 |

## 数据流

1. 输入 → `POST /api/chat` + `sessionId`  
2. SessionStore 取最近历史  
3. Hybrid 检索 `knowledge/`（关键词 + 向量）  
4. 命中片段进入 system → LLM  
5. 写回会话；返回 answer/sources/retrieval/latencyMs  
6. 前端气泡 + TTS；展览播放可 `GET /api/suggestions?zone=`  

## 非目标（当前）

STT、生产鉴权、集群、向量库服务、STT/CRM 对接。详见 [code-review.md](./code-review.md)。
