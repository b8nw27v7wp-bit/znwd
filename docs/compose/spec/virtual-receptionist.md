---
feature: virtual-receptionist
status: delivered
updated: 2026-09-17
branch: feature/virtual-receptionist
commits: a485ed5906df7d18acbf1e25d12874825c178b01..3edd3904aafe347aa6ac8f9058270ce63772c2bb
---

# 研究院门口 AI 虚拟接待问答

## Report

**What was built** — 在 `E:\znwd` 搭建可运行 monorepo：左侧约 1/3 为 Live2D 占位虚拟形象（待机/思考/说话口型），右侧约 2/3 为对话窗口；`knowledge/` 本地文档经 Fastify RAG 检索后由可插拔 LLM（默认 mock，可切 OpenAI 兼容内网）生成回答；前端用 `speechSynthesis` 自动朗读并支持静音/停止。

**Verification** — `npm install`；`npm run build -w server` / `-w web` 均 PASS；经 Vite 代理 `http://localhost:5173`：`GET /api/health` ok；中文提问 `mode=rag` 且 sources>0；无命中 query 返回 `mode=llm_only` 与「暂未检索到」文案。独立 Review：无 CRITICAL；已修复 MAJOR（Mock 无命中分支）及若干 MINOR。

**Journey log** — 空目录非 git，已 `git init` 并建 `feature/virtual-receptionist`；沙箱禁止 `git worktree add`，未用 worktree。PowerShell `Invoke-RestMethod` 中文易乱码，联调改用 Node `fetch`。Monorepo 提升依赖到根 `node_modules`，后台启动需从该路径调 `vite`/`tsx`。

## [S1] Problem

研究院办公室门口需要一名常驻「AI 虚拟接待员」：参观人员到达后，可在对话窗口提问；系统基于**企业内数据**给出回答，并用**语音朗读**。当前无任何系统承载该场景，需要从零搭建可运行的前后端框架与问答链路骨架。

## [S2] Design

### 2.1 展示形态

- **浏览器大屏网页**：单页应用，无边框全屏，适配横屏 16:9 及以上分辨率。
- **左右分栏**：
  - **左侧约 1/3**：Live2D 虚拟人物（含呼吸/待机、说话口型、可选表情切换）。
  - **右侧约 2/3**：对话式聊天窗口（历史消息流 + 输入区 + 发送）。
- 浅色极简工程风：白底、无边框卡片、大留白、主文字 `#1d1d1f`、Apple 字体栈。

### 2.2 用户交互流程

```
参观人员输入问题 → 发送 → 前端 POST /api/chat
  → 后端检索企业知识（RAG）→ 调 LLM 生成回答
  → 返回 answer + 可选引用片段
  → 前端渲染气泡 → 触发 TTS 朗读 → Live2D 口型同步（可选）
```

- 支持键盘/触屏输入；回车或按钮发送。
- 回答生成期间显示「思考中」状态，禁止重复发送。
- TTS 朗读可暂停/停止；切换新回答时取消上一条朗读。

### 2.3 后端架构（本地 RAG 骨架 + 可插拔 LLM）

**技术选型**：Node.js + TypeScript + Fastify（与前端同语言，单仓 monorepo 便于协同）。

**模块**：

| 模块 | 职责 | 首版实现 |
|------|------|----------|
| `knowledge` | 企业文档加载、切块、索引 | 目录扫描 `.md`/`.txt`；按段落/字数切块；内存向量或关键词检索（BM25/简单 embedding 接口） |
| `rag` | 检索 + 组装 prompt | top-k 检索片段拼入系统提示词 |
| `llm` | 可插拔大模型 | 统一 `ChatModel` 接口；实现 `MockChatModel`（默认）与 `OpenAICompatChatModel`（env 配置 baseURL/key/model，可接内网） |
| `tts`（可选服务端） | 服务端 TTS | 首版前端浏览器 Web Speech API；预留服务端接口形态 |
| `http` | API | `POST /api/chat`、`GET /api/health`、`POST /api/knowledge/reload` |

**环境变量**（`.env.example`）：

```
LLM_PROVIDER=mock | openai_compat
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
KNOWLEDGE_DIR=./knowledge
PORT=8787
```

**`POST /api/chat` 契约**：

请求：

```json
{ "message": "什么是XX技术？", "sessionId": "optional-uuid" }
```

响应：

```json
{
  "answer": "…",
  "sources": [{ "title": "…", "snippet": "…", "score": 0.0 }],
  "mode": "rag" | "llm_only"
}
```

错误：400 空消息；500 附 `{ "error": "…" }`。

### 2.4 前端架构

**技术选型**：Vite + React + TypeScript。

**布局**：

- `.app`：`grid-template-columns: 1fr 2fr`（左 Live2D / 右对话），高度 `100vh`。
- 左栏：`Live2DStage` 组件 + 状态（idle / listening / thinking / speaking）。
- 右栏：`ChatPanel`（消息列表 + `Composer`）。

**Live2D**：

- 使用 `pixi.js` + `@pixi-live2d-display`（或 Cubism 4 Runtime）加载本地 `.model3.json` 资源。
- **占位策略**：仓库不携带商业模型；提供 `public/live2d/README` 说明与 **CSS/Canvas 占位形象**（几何头像 + 口型动画），保证无模型时链路可演示。
- 口型：TTS `speaking` 期间驱动 `mouthOpen` 参数；TTS 结束或取消时归零。

**TTS**：

- 首选 `window.speechSynthesis`（中文 `zh-CN` 语音优先）。
- 封装 `useSpeech`：`speak(text)` / `stop()` / 状态 `idle|speaking`。
- 新回答到达时 `stop()` 再 `speak`。

### 2.5 知识数据

- 本地目录 `knowledge/`，首版纳入示例企业文档（研发方向、参观须知、联系人等占位内容，可替换）。
- 热更新：`POST /api/knowledge/reload` 重建索引。
- 不在首版实现权限体系/多租户；文档放在服务器可读目录即可。

### 2.6 错误与降级

| 场景 | 行为 |
|------|------|
| LLM 未配置 | `mock` 提示词模板回答，或明确「演示模式」文案 |
| 检索无命中 | 仍走 LLM；`mode=llm_only`，前端可提示「未找到内部资料，以下为通用回答」 |
| TTS 不可用 | 静默降级，界面提示浏览器语音不可用 |
| 网络失败 | 气泡显示错误文案，允许重试 |

### 2.7 目录结构（monorepo）

```
znwd/
├── docs/compose/spec/virtual-receptionist.md
├── package.json                 # workspaces: web, server
├── knowledge/                   # 企业文档（示例可替换）
├── server/
│   ├── package.json
│   ├── src/
│   │   ├── index.ts             # 启动 Fastify
│   │   ├── routes/chat.ts
│   │   ├── rag/pipeline.ts
│   │   ├── knowledge/loader.ts
│   │   ├── knowledge/retriever.ts
│   │   └── llm/types.ts | mock.ts | openaiCompat.ts
│   └── .env.example
└── web/
    ├── package.json
    ├── index.html
    ├── vite.config.ts
    └── src/
        ├── App.tsx
        ├── components/Live2DStage.tsx | ChatPanel.tsx | MessageBubble.tsx | Composer.tsx
        ├── hooks/useSpeech.ts
        └── api/client.ts
```

### 2.8 明确不做（本阶段）

- 语音识别（STT）、摄像头/人流统计、多轮记忆长期化、用户登录、Live2D 商业模型资产、生产级部署（HTTPS/反代/集群）、移动端适配。

## [S3] Out of Scope

- STT 语音提问。
- 真实企业机密文档与内网生产联调（本阶段用示例文档 + mock/可配置 LLM）。
- Unity/桌面客户端形态。
- 完整设计系统与多语言。

## Tasks

- [x] T1: 初始化 monorepo（root workspaces、README、.gitignore、knowledge 示例文档、.env.example） — acceptance: 根目录可 `npm install`；`knowledge/` 含可检索示例文档 (covers: S2.5, S2.7)
- [x] T2: 搭建 server：Fastify + `/api/health` + `/api/chat`（Mock LLM + 关键词/BM25 检索 RAG） — acceptance: `npm run dev` 后 curl health 返回 ok；chat 返回 answer/sources；LLM_PROVIDER=openai_compat 时走 OpenAI 兼容接口 (covers: S2.3)
- [x] T3: 搭建 web：Vite React 布局（左 1/3 Live2D 占位、右 2/3 对话）+ 发送/流式气泡状态 — acceptance: 浏览器打开分栏 UI，可提问并渲染 mock 回答 (covers: S2.1, S2.4)
- [x] T4: 接入 `useSpeech` TTS 朗读与 Live2D 口型/状态联动（占位形象可驱动） — acceptance: 回答出现后自动朗读；说话时左侧形象有口型/动效；停止按钮可用 (covers: S2.2, S2.4)
- [x] T5: 联调与文档：web 代理 `/api` 到 server；根 README 启动说明与替换 LLM/知识库指引 — acceptance: 按 README 三步启动，端到端完成一次带朗读的问答 (covers: S2.2, S2.3, S2.5)
