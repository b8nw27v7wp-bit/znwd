# AI 虚拟讲解问答（产品展厅）

浏览器大屏：**整页仅占左约 1/3**——上方虚拟形象（Live2D 占位可替换），**下方对话框**；右侧约 2/3 留白（可并排放展览视频）。  
基于本地企业知识 **Hybrid RAG** 与可插拔 **LLM** 生成回答，浏览器 **TTS 朗读**。

当前知识业务：**光伏清洁无人机**、**风场检测无人机**（及服务/展厅须知）。

## 快速开始

```bash
npm install
cp server/.env.example server/.env   # 可选：配置 LLM / Embedding
npm run dev:server                    # :8787
npm run dev:web                       # :5173（代理 /api）
```

打开 `http://localhost:5173`，在对话区提问（Enter 发送）。

## 项目结构

```
znwd/
├── README.md
├── CHANGELOG.md
├── docs/                     # 工程文档（见 docs/README.md）
│   ├── api.md
│   ├── knowledge.md
│   ├── code-review.md
│   └── compose/spec/
├── knowledge/                # RAG 知识（可整目录替换业务资料）
│   ├── _meta/zones.json
│   ├── 01_光伏清洁无人机/
│   ├── 02_风场检测无人机/
│   ├── 03_服务与合作/
│   └── 90_通识/
├── server/                   # Fastify + Hybrid RAG
│   ├── .env.example
│   ├── indexes/              # 向量索引（不入库）
│   └── src/
└── web/                      # Vite React
    └── src/
```

## 常用 API

- `GET /api/health`
- `GET /api/suggestions`（`?zone=pv-clean` / `wind-inspect` / `exhibit-*`）
- `GET /api/zones`
- `POST /api/chat` — `{ "message", "sessionId" }`
- `POST /api/chat/stream` — SSE
- `GET /api/openapi.json`
- `GET|DELETE /api/sessions/:sessionId`
- `POST /api/feedback`
- `GET /api/stats`（可选 `ADMIN_TOKEN`）
- `GET /api/knowledge/list`
- `POST /api/knowledge/reload`（可选 `ADMIN_TOKEN`）

测试：`npm test -w server`；API 审计：`node server/scripts/api-audit.mjs`。审计报告：[docs/code-audit.md](docs/code-audit.md)。

## 配置

`server/.env`：

```
LLM_PROVIDER=mock | openai_compat
LLM_BASE_URL=...
EMBED_PROVIDER=bag | openai_compat
EMBED_MODEL=...
# ADMIN_TOKEN=secret
# KNOWLEDGE_WATCH=true
```

知识正文替换与检索说明：[docs/knowledge.md](docs/knowledge.md)。  
代码排查记录：[docs/code-review.md](docs/code-review.md)。

## 构建

```bash
npm run build
```
