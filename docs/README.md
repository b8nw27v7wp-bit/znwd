# 项目文档

产品展厅 AI 虚拟讲解问答（`znwd`）——当前业务：**光伏清洁无人机 / 风场检测无人机**。

## 文档一览

| 文档 | 用途 |
|------|------|
| [../README.md](../README.md) | 快速开始、目录一览 |
| [architecture.md](./architecture.md) | 系统架构、模块边界、数据流 |
| [api.md](./api.md) | HTTP API 契约 |
| [development.md](./development.md) | 本地开发、目录规范、提交约定 |
| [knowledge.md](./knowledge.md) | 知识库分区维护与 Hybrid 检索 |
| [deployment.md](./deployment.md) | 展厅/一体机部署 |
| [code-review.md](./code-review.md) | 早期代码排查 |
| [code-audit.md](./code-audit.md) | 代码审计与功能测试报告 |
| [compose/spec/](./compose/spec/) | 历史功能 Spec |
| [../CHANGELOG.md](../CHANGELOG.md) | 版本变更记录 |

## 目录约定

```
docs/                  # 工程文档（不含业务知识正文）
knowledge/             # RAG 业务知识（按展区子目录 + _meta/zones.json）
  _meta/               # 展区元数据；不进入检索
  01_光伏清洁无人机/
  02_风场检测无人机/
  03_服务与合作/
  90_通识/
server/                # Fastify + Hybrid RAG + LLM/Embedding
  indexes/             # 本地向量索引（gitignore）
web/                   # Vite React：左 1/3 形象 + 下方对话
```

规则：

1. 工程说明 → `docs/` 或根 `README` / `CHANGELOG`。  
2. 进入检索的知识 → 仅 `knowledge/` 业务子目录。  
3. 展区/推荐问题/媒体映射 → `knowledge/_meta/zones.json`。  
4. `.env`、`dist/`、`server/indexes/`、日志不入库。  
5. Spec → `docs/compose/spec/<feature>.md`。  
