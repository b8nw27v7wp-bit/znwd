# AI 虚拟接待问答（研究院门口）

浏览器大屏：**左 1/3 Live2D 虚拟形象**（占位动画可替换）+ **右 2/3 对话窗口**；回答走本地 RAG + 可插拔 LLM，前端自动 **TTS 朗读**。

## 快速开始

```bash
# 1) 安装依赖
npm install

# 2)（可选）配置 LLM
cp server/.env.example server/.env
# 默认 LLM_PROVIDER=mock，可改为 openai_compat 并填写内网网关

# 3) 启动
npm run dev:server   # http://127.0.0.1:8787
npm run dev:web      # http://127.0.0.1:5173  （已代理 /api）
```

浏览器打开 `http://127.0.0.1:5173`，在右侧输入问题（Enter 发送）。回答生成后自动朗读。

## 目录

| 路径 | 说明 |
|------|------|
| `knowledge/` | 企业内部知识文档（`.md`/`.txt`），可直接替换 |
| `server/` | Fastify API：chat / health / knowledge reload + RAG + LLM 适配 |
| `web/` | Vite + React 前端 |
| `docs/compose/spec/virtual-receptionist.md` | 功能 Spec |

## API

- `GET /api/health`
- `POST /api/chat` — `{ "message": "..." }`
- `POST /api/knowledge/reload`

## 替换 LLM（内网 OpenAI 兼容）

`server/.env`：

```
LLM_PROVIDER=openai_compat
LLM_BASE_URL=https://your-gateway/v1
LLM_API_KEY=...
LLM_MODEL=your-model
```

## 替换 Live2D 模型

当前为 CSS 占位形象。将 Cubism 4 模型放入 `web/public/live2d/` 后，可按 `Live2DStage.tsx` 注释接入 `pixi.js` + `@pixi-live2d-display`（需自备模型授权文件）。
