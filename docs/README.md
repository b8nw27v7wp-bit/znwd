# 项目文档

研究院门口 AI 虚拟接待问答（`znwd`）的文档索引。

## 文档一览

| 文档 | 用途 |
|------|------|
| [../README.md](../README.md) | 快速开始、目录一览、常见替换操作 |
| [architecture.md](./architecture.md) | 系统架构、模块边界、数据流 |
| [api.md](./api.md) | HTTP API 契约 |
| [development.md](./development.md) | 本地开发、目录规范、提交约定 |
| [knowledge.md](./knowledge.md) | 企业知识库维护与热更新 |
| [deployment.md](./deployment.md) | 展厅/一体机部署与运行注意 |
| [compose/spec/virtual-receptionist.md](./compose/spec/virtual-receptionist.md) | 功能 Spec（设计与交付记录） |
| [../CHANGELOG.md](../CHANGELOG.md) | 版本变更记录 |

## 阅读路径

- **第一次上手**：README → development → architecture  
- **对接/联调**：api → knowledge  
- **上机部署**：deployment  
- **追溯设计**：compose/spec → CHANGELOG  

## 目录约定

```
docs/                  # 项目文档（本目录，除知识库业务正文外只放工程文档）
knowledge/             # 面向问答的企业知识正文（业务数据，可整目录替换）
server/                # 后端 API 与 RAG
web/                   # 前端对话与虚拟形象
```

规则：

1. 工程说明、API、架构、变更 → `docs/` 或根 `README.md` / `CHANGELOG.md`。  
2. 进入检索的知识正文 → 仅 `knowledge/`，勿混入架构说明。  
3. 单次功能的完整设计/验收 → `docs/compose/spec/<feature>.md`。  
4. 运行日志、`.env`、`dist/` 不入库（见 `.gitignore`）。  
