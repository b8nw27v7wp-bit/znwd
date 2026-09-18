# 开发指南

## 环境要求

- Node.js 20+（本机验证：v24）
- npm 10+（workspaces）
- 浏览器：支持 `speechSynthesis` 的 Chromium / Edge 等

## 常用命令

在仓库根目录 `E:\znwd`：

```bash
npm install              # 安装全部 workspace 依赖
npm run dev:server       # 后端 :8787（tsx watch）
npm run dev:web          # 前端 :5173（代理 /api → 8787）
npm run build            # server tsc + web vite build
npm run start            # 以 server/dist 启动（需先 build）
```

开发时**两个终端**分别跑 `dev:server` 与 `dev:web`。

## 本地验证清单

1. `GET http://localhost:5173/api/health` → `ok: true`  
2. 页面左右分栏；提问 Enter 发送  
3. 右侧出现回答与「资料来源」；左侧进入朗读/口型  
4. 无命中问题 → 提示「未命中内部资料」且 mock 文案为「暂未检索到」  

联调请用 Node `fetch` 或浏览器；PowerShell `Invoke-RestMethod` 可能对中文 JSON 乱码。

## 目录规范

| 位置 | 放什么 | 不放什么 |
|------|--------|----------|
| 根 `README.md` | 三分钟上手 | 长篇架构 |
| `CHANGELOG.md` | 版本与迁移说明 | 日志流水 |
| `docs/` | 架构、API、部署、开发约定 | 业务知识正文 |
| `docs/compose/spec/` | 功能 Spec（设计+验收） | 重复 README |
| `knowledge/` | **仅**进入 RAG 的企业文档 | 工程说明 |
| `server/src/` | API、RAG、LLM 适配 | UI 组件 |
| `web/src/` | 界面与语音 | 直接读知识文件 |
| `web/public/live2d/` | 模型资产与说明 | 源码 |
| `.env` | 本机密钥（已 gitignore） | 提交到 git |

新增文档：优先挂到 [docs/README.md](./README.md) 索引表。

## 代码约定

- 语言：TypeScript strict；服务端 ESM + `NodeNext`（相对导入带 `.js`）。  
- 样式：浅色极简、白底、`#1d1d1f`，少注释，命名表意图。  
- 新 LLM：实现 `ChatModel`，在 `server/src/llm/index.ts` 注册，用 `LLM_PROVIDER` 切换。  
- 新 UI：保持左右 1fr/2fr 分栏与现设计 token 一致。  

## 分支与提交

- 功能分支：`feature/<slug>`（当前：`feature/virtual-receptionist`）。  
- 提交信息：`feat:` / `fix:` / `docs:` / `chore:` + 简短英文或中英混合摘要。  
- 不提交：`node_modules/`、`dist/`、`*.log`、`.env`、`*.tsbuildinfo`。  

## Spec 流程（可选）

较大功能建议：`docs/compose/spec/<feature>.md` 写清 S1/S2/S3 与 Tasks，实现后勾选并写 Report。
