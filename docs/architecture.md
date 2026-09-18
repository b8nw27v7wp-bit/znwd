# 系统架构

## 总览

```
参观人员
   │
   ▼
┌──────────────────────────────────────────────┐
│  web/  浏览器大屏                             │
│  ┌──────────────┐  ┌──────────────────────┐  │
│  │ 仅左 1/3     │  │ 右侧 2/3 留白        │  │
│  │ ┌──────────┐ │  │                      │  │
│  │ │ Live2D   │ │  │                      │  │
│  │ │ (上)     │ │  │                      │  │
│  │ ├──────────┤ │  │                      │  │
│  │ │ 聊天框   │ │  │                      │  │
│  │ │ (下)     │ │  │                      │  │
│  │ └────┬─────┘ │  │                      │  │
│  └──────┼───────┘  └──────────────────────┘  │
│         │ TTS + POST /api/chat (Vite 代理)   │
└─────────┼────────────────────────────────────┘
          ▼
┌──────────────────────────────────────────────┐
│  server/  Fastify                            │
│  routes → rag/pipeline → knowledge/retriever │
│                 │              ▲              │
│                 ▼              │ 扫描加载     │
│            llm/* (ChatModel)  knowledge/*.md  │
└──────────────────────────────────────────────┘
```

## 技术选型

| 层 | 选型 | 原因 |
|----|------|------|
| 前端 | Vite + React + TS | 展厅网页、迭代快、同仓 TS |
| 后端 | Fastify + TS (ESM) | 轻量 API，与前端同语言 |
| 检索 | **Hybrid**：关键词 + 本地向量 RRF | 离线可用，接内网 embeddings 可升级 |
| 向量 | JSON 文件库 + `bag`/`openai_compat` Embedding | 零外部服务；可换 bge 等中文模型 |
| LLM | 可插拔 `ChatModel` | 默认 mock；内网 OpenAI 兼容网关 |
| 语音 | 浏览器 `speechSynthesis` | 无服务端 TTS 成本，先跑通链路 |
| 形象 | CSS 占位 + 预留 Live2D | 无版权模型也能演示；可后换 Cubism |

## 模块边界

### server/

| 路径 | 职责 |
|------|------|
| `src/index.ts` | 进程入口：加载 `.env`、装载知识、挂载路由 |
| `src/routes/chat.ts` | `POST /api/chat` 入参校验与错误码 |
| `src/knowledge/loader.ts` | 扫描分区知识、frontmatter、zones 元数据 |
| `src/knowledge/retriever.ts` | 关键词路（bigram + 标题/标签加权） |
| `src/knowledge/vectorStore.ts` | 本地向量索引（JSON 持久化） |
| `src/knowledge/hybridRetriever.ts` | RRF 融合两路结果 |
| `src/embedding/*` | `bag` / `openai_compat` 向量提供方 |
| `src/rag/pipeline.ts` | 组 prompt（含会话历史）、调 ChatModel、组装 sources |
| `src/session/store.ts` | 内存多轮会话（6 轮 / TTL 10 分钟 / peek） |
| `src/analytics/stats.ts` | 问答与反馈内存统计 |
| `src/http/rateLimit.ts` | 每 IP chat 限流 |
| `src/routes/knowledge.ts` | 知识 list / reload |
| `src/knowledge/suggestions.ts` | 按展区/媒体 ID 的推荐问题 |
| `src/llm/*` | `mock` / `openai_compat` 实现 |

### web/

| 路径 | 职责 |
|------|------|
| `src/App.tsx` | 分栏布局、发送状态机、朗读触发 |
| `src/components/Live2DStage.tsx` | 虚拟形象与 mood（idle/thinking/speaking） |
| `src/components/ChatPanel.tsx` 等 | 消息列表、气泡、输入框 |
| `src/hooks/useSpeech.ts` | TTS speak/stop/mute |
| `src/api/client.ts` | `/api/chat` 封装 |

## 数据流（一次问答）

1. 用户在右侧输入（或点推荐 chips）→ `client.sendChat` + `sessionId`  
2. Vite 将 `/api` 转发到 `http://127.0.0.1:8787`  
3. `SessionStore` 取该会话最近历史（≤6 轮）  
4. 服务端检索 `knowledge/` → 命中片段写入 system，历史插在 system 与当前 user 之间  
5. `ChatModel.complete` 返回文案（mock 或内网 LLM）  
6. 写入 SessionStore；响应 `{ answer, sources, mode, provider }` 渲染气泡  
7. `speechSynthesis` 朗读；左侧 mood 切 `speaking` 并驱动口型  
8. 新提问时先 `cancel` 旧语音再重新 speak  
9. 闲置 120s：换新 `sessionId`、欢迎语复位  

另：`GET /api/suggestions` 提供推荐问题；前端每 15s `GET /api/health` 更新连接状态。

## 关键契约

- 聊天请求/响应见 [api.md](./api.md)。  
- LLM 配置见 `server/.env.example`。  
- 知识目录默认 `KNOWLEDGE_DIR=./knowledge`（相对仓库根解析）。

## 非目标（当前阶段）

- STT 语音提问、用户体系、多机集群、HTTPS 生产入口、向量库/Embedding 服务。  
