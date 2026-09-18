# AI 虚拟接待问答（研究院门口）

浏览器大屏：**左约 1/3 虚拟形象**（Live2D 占位可替换）+ **右约 2/3 对话窗**；基于本地企业知识 **RAG** 与可插拔 **LLM** 生成回答，并用浏览器 **TTS 朗读**。

## 快速开始

```bash
# 1) 安装依赖
npm install

# 2)（可选）配置 LLM
cp server/.env.example server/.env
# 默认 LLM_PROVIDER=mock；可改为 openai_compat 并填内网网关

# 3) 启动（两个终端）
npm run dev:server   # http://127.0.0.1:8787
npm run dev:web      # http://127.0.0.1:5173  （已代理 /api）
```

打开 `http://localhost:5173`，右侧提问（Enter 发送），回答生成后自动朗读。

## 项目结构

```
znwd/
├── README.md                 # 本说明（快速开始）
├── CHANGELOG.md              # 版本变更
├── package.json              # npm workspaces 根
├── docs/                     # 工程文档（索引起点 docs/README.md）
│   ├── README.md
│   ├── architecture.md
│   ├── api.md
│   ├── development.md
│   ├── knowledge.md
│   ├── deployment.md
│   └── compose/spec/         # 功能 Spec
├── knowledge/                # 企业知识正文（RAG 数据，可整目录替换）
├── server/                   # Fastify + RAG + LLM
│   ├── .env.example
│   └── src/
└── web/                      # Vite React 前端
    ├── public/live2d/        # 模型资产说明
    └── src/
```

更细的目录规则见 [docs/development.md](docs/development.md)。

## 文档

| 文档 | 说明 |
|------|------|
| [docs/README.md](docs/README.md) | 文档索引 |
| [docs/architecture.md](docs/architecture.md) | 架构与数据流 |
| [docs/api.md](docs/api.md) | HTTP API |
| [docs/development.md](docs/development.md) | 开发与目录规范 |
| [docs/knowledge.md](docs/knowledge.md) | 知识库维护 |
| [docs/deployment.md](docs/deployment.md) | 展厅部署 |
| [docs/compose/spec/virtual-receptionist.md](docs/compose/spec/virtual-receptionist.md) | 功能 Spec v0.1 框架 |
| [docs/compose/spec/reception-ux.md](docs/compose/spec/reception-ux.md) | 功能 Spec v0.2 接待体验 |

## 常用 API

- `GET /api/health`
- `GET /api/suggestions`
- `POST /api/chat` — `{ "message": "...", "sessionId": "..." }`（同会话多轮）
- `POST /api/knowledge/reload`

详情：[docs/api.md](docs/api.md)。

## 替换 LLM（内网 OpenAI 兼容）

`server/.env`：

```
LLM_PROVIDER=openai_compat
LLM_BASE_URL=https://your-gateway/v1
LLM_API_KEY=...
LLM_MODEL=your-model
```

## 替换虚拟形象

将 Cubism 4 模型放入 `web/public/live2d/`，按该目录 README 与 `Live2DStage.tsx` 注释接入；需自备模型授权。

## 构建

```bash
npm run build
```
