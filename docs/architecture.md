# 系统架构

## 总览

```
参观人员
   │
   ▼
┌──────────────────────────────────────────────┐
│  web/  浏览器大屏                            │
│  ┌─────────────┐  ┌──────────────────────┐   │
│  │ Live2D 舞台  │  │ 对话窗 Chat + 输入    │   │
│  │ (左约 1/3)   │  │ (右约 2/3)           │   │
│  │ 口型/状态    │  │ 气泡 + 引用 + 状态    │   │
│  └──────┬──────┘  └──────────┬───────────┘   │
│         │ TTS speechSynthesis│               │
│         └──────────┬─────────┘               │
│                    │ POST /api/chat (Vite 代理)│
└────────────────────┼─────────────────────────┘
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
| 检索 | 本地文件 + 关键词打分 | 零外部依赖，企业内网可离线 |
| LLM | 可插拔 `ChatModel` | 默认 mock；内网 OpenAI 兼容网关 |
| 语音 | 浏览器 `speechSynthesis` | 无服务端 TTS 成本，先跑通链路 |
| 形象 | CSS 占位 + 预留 Live2D | 无版权模型也能演示；可后换 Cubism |

## 模块边界

### server/

| 路径 | 职责 |
|------|------|
| `src/index.ts` | 进程入口：加载 `.env`、装载知识、挂载路由 |
| `src/routes/chat.ts` | `POST /api/chat` 入参校验与错误码 |
| `src/knowledge/loader.ts` | 扫描 `.md`/`.txt`，分块 |
| `src/knowledge/retriever.ts` | 中英文分词式关键词检索，top-k |
| `src/rag/pipeline.ts` | 组 prompt（含会话历史）、调 ChatModel、组装 sources |
| `src/session/store.ts` | 内存多轮会话（6 轮 / TTL 10 分钟） |
| `src/knowledge/suggestions.ts` | 展厅推荐问题 |
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
