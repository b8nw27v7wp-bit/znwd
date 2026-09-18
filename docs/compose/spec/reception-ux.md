---
feature: reception-ux
status: delivered
updated: 2026-09-17
branch: feature/virtual-receptionist
commits: 
---

# 接待体验增强（v0.2）

## Report

**What was built** — 同 `sessionId` 多轮 RAG 上下文（内存 6 轮/TTL 10 分钟）；`GET /api/suggestions` + 前端推荐 chips；闲置 120s 自动复位；15s health 状态条与「重新开始」。Mock 在多轮时回显「已结合前序 N 轮」便于验收。

**Verification** — `npm run build -w server` / `-w web` PASS；curl：suggestions 4 条；同 session 第二问 answer 含「已结合前序 1 轮对话上下文」且 `mode=rag`。

**Journey log** — `Start-Process` + `$args` 在部分环境与内置参数冲突，改用数组字面量/单行参数；monorepo tsx 须用根目录 `node_modules` 路径。

## [S1] Problem

v0.1 骨架可单轮问答，但展厅场景不足：无多轮上下文、访客不知道问什么、无空闲复位、后端不可用时无提示。下一增量补齐接待动线，不引入 STT/向量库/Live2D 商业模型。

## [S2] Design

### 2.1 多轮会话上下文

- 前端加载时生成 `sessionId`，每次 `POST /api/chat` 携带。
- 服务端内存 `SessionStore`：按 `sessionId` 保存最近 **6** 轮 user/assistant 消息（超出丢弃最旧）。
- `pipeline.answerQuestion` 接收 `history: ChatMessage[]`，在 system 与当前 user 之间插入历史。
- TTL **10 分钟**（按 lastActive）；超容量会话复位。进程重启清空可接受。
- 无 `sessionId` 时仍可单轮问答（history 空）。

### 2.2 推荐问题

- `GET /api/suggestions` 返回固定展厅引导 4 条（与示例知识对齐，不依赖向量）：

```json
{ "items": ["研究院主要做哪些方向？", "参观需要预约吗？", "能否现场参观？有讲解吗？", "如何接入开放平台？"] }
```

- 前端在欢迎语下方展示 chips；点击 = 等同发送。`busy` 时禁用。

### 2.3 空闲自动复位

- 任一输入/点击/按键刷新 `lastActive`；距上次活动超过 **120s** 且非 `busy`/非朗读中：复位。
- 复位：换新 `sessionId`、回到欢迎消息、清输入、`stop()` 朗读、恢复推荐 chips。
- 复位时若在朗读则先 cancel。

### 2.4 连接状态

- 前端每 **15s** `GET /api/health`；失败 → 顶栏「服务未连接」，成功 → 「在线」。
- 初始未探测前显示「连接中…」。

### 2.5 API 变更

| 接口 | 变更 |
|------|------|
| `POST /api/chat` | 请求可带 `sessionId`；服务端维护多轮 history |
| `GET /api/suggestions` | **新增** `{ items: string[] }` |

### 2.6 UI

- 欢息语下方 chips 样式：浅灰底、小圆角、单行可换行。
- 顶栏右侧小字状态（在线/连接中/服务未连接）。
- 仍保持浅色极简、`#1d1d1f`。

## [S3] Out of Scope

- STT、向量检索/Embedding、流式 SSE、持久化会话（Redis/DB）、鉴权、Live2D 真模型。

## Tasks

- [x] T1: Spec 落盘 `docs/compose/spec/reception-ux.md` — acceptance: status=in-progress，含契约与验收 (covers: S1, S2)
- [x] T2: 后端 SessionStore + history 注入 + `GET /api/suggestions` — acceptance: 同 sessionId 第二问可见上下文；suggestions 返回 4 条 (covers: S2.1, S2.5)
- [x] T3: 前端 sessionId、chips、120s 复位、health 状态条 — acceptance: 点击推荐可问；闲置 2 分钟自动复位；断开显示未连接 (covers: S2.2, S2.3, S2.4)
- [x] T4: build + E2E + 更新 README/api/CHANGELOG 并提交 — acceptance: build PASS；curl 验证 suggestions 与多轮；文档已改 (covers: S2)
