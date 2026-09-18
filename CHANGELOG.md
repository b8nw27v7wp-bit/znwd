# Changelog

本项目版本与变更记录。日期：YYYY-MM-DD。

## [0.2.0] — 2026-09-17

接待体验增强（feature: reception-ux）。

### Added

- 会话多轮上下文：内存 `SessionStore`，同 `sessionId` 最近 6 轮 / TTL 10 分钟  
- `GET /api/suggestions` 推荐问题；前端 chips 点击即问  
- 闲置 **120s** 自动复位（新会话、欢迎语、停朗读）  
- 顶栏连接状态（连接中/在线/服务未连接），15s health 探测  
- 左侧「重新开始」按钮  

### Notes

- 会话仅存进程内存，重启即清空；无 STT/向量库  

## [0.1.0] — 2026-09-17

首个可运行框架（feature/virtual-receptionist）。

### Added

- npm workspaces monorepo：`server` + `web` + `knowledge` + `docs`  
- 后端 Fastify：`GET /api/health`、`POST /api/chat`、`POST /api/knowledge/reload`  
- 本地 RAG：Markdown/TXT 加载、分块、关键词检索 top-k  
- 可插拔 LLM：默认 `mock`；`openai_compat` 支持内网网关  
- 前端 Vite + React：左约 1/3 虚拟形象占位、右约 2/3 对话  
- 浏览器 TTS 自动朗读、静音/停止；与形象 mood 联动  
- 示例知识库 3 篇；功能 Spec 与文档索引  

### Fixed

- Mock 在无命中时仍声称「已有院内资料」（与 `mode=llm_only` 矛盾）  
- `.env` 改为相对 `server` 目录加载  
- `voiceReady` 初值、`speechSynthesis.cancel` 守卫、message 长度截断  

### Notes

- Live2D 为 CSS 占位，模型接入见 `web/public/live2d/README.md`  
- 无 STT、无鉴权，仅适合内网单机演示  

---

## 模板

```markdown
## [x.y.z] — YYYY-MM-DD

### Added
### Changed
### Fixed
### Notes
```
