# 项目文档

产品展厅 AI 虚拟讲解问答（`znwd`）——当前业务：**光伏清洁机器人 / 光伏医生智慧运维 / 项目与团队**（语料来自三份申报与项目概述材料）。

技术栈：后端 Spring Boot 3.5.16（Java 21 目标）+ MyBatis + MySQL；前端 Vue 3 + Vite 6 + TypeScript。

## 文档一览

| 文档 | 用途 |
|------|------|
| [../README.md](../README.md) | 快速开始、命令一览、目录结构 |
| [architecture.md](./architecture.md) | 分层与包结构、问答时序、检索流水线、并发与存储、扩展点 |
| [api.md](./api.md) | HTTP API 契约（含 SSE 协议、鉴权、错误信封） |
| [development.md](./development.md) | 本地开发、常用命令、日常改动落点、Windows 坑与 CI |
| [knowledge.md](./knowledge.md) | 知识库分区维护、分块与打分、同义词维护、改知识后的必做流程 |
| [eval.md](./eval.md) | 检索评测与阈值标定（用例口径、指标、基线、标定工具） |
| [deployment.md](./deployment.md) | 展厅/一体机部署、本机 MySQL 初始化、出网降级、运维与备份 |
| [HERMES_HANDOFF.md](./HERMES_HANDOFF.md) | 2026-09-24 交接快照（历史，已被 `CHANGELOG.md` 与活文档取代，不代表现状） |
| [CODE_REVIEW_HANDOFF.md](./CODE_REVIEW_HANDOFF.md) | 2026-09-24 代码审核交接快照（历史；审核表于 2026-09-29 复核，现状以 `CHANGELOG.md` 与活文档为准） |
| [REPAIR_PLAN.md](./REPAIR_PLAN.md) | 2026-09-24 修复计划快照（历史，P0/P1/P2 任务多数已落地，不代表现状） |
| [plan.md](./plan.md) | 语音播报修复计划（2026-09-22 历史快照，P0/P1/P2 已完成） |
| [optimization-backlog.md](./optimization-backlog.md) | 已修问题、待做项、已知取舍 |
| [security.md](./security.md) | 安全口径：已加固项、已核查项、已接受的风险、上线检查清单 |
| [security-testing.md](./security-testing.md) | 边界与安全测试用例：编号、输入、期望、实测结果，以及明确接受的风险 |
| [test-cases.md](./test-cases.md) | 全幅度测试用例：按功能域分组的用例设计、优先级、自动化归属与覆盖缺口 |
| [eval/](./eval/) | 评测基线与历史报告（json） |
| [archive/](./archive/) | Node 时代的代码审查/审计文档与交接计划 `old-node-plan.md`（仅存档，不代表现状） |
| [compose/spec/](./compose/spec/) | 早期功能 Spec（历史记录） |

## 目录约定

```
docs/                  # 工程文档（不含业务知识正文）
knowledge/             # RAG 业务知识（按展区子目录 + _meta/zones.json 管展区与推荐问题）
  _meta/               # 展区元数据、同义词覆盖表 synonyms.tsv；不进入检索
  01_光伏清洁机器人/
  02_光伏医生运维系统/
  03_项目与团队/
server/                # Spring Boot：HTTP / RAG / LLM / MySQL
  db/init.sql          # 建库建账号（首次部署执行一次）
  indexes/             # 本地向量索引（不入库，可重建）
  src/main/java/com/znwd/hostess/
web/                   # Vue 3 + Vite：左约 1/4 形象 + 下方对话
tools/                 # mvn（Maven 包装脚本）、smoke.py（接口契约冒烟）、
                       # security.py（边界与安全用例）、db-check.py（库层脱敏与最小权限核查）、
                       # offline-check.py（「除大模型、embedding 与可选语音服务外一律本地」不变量）、
                       # acceptance.py（问答内容验收：该答的答对没有、该拒的拒了没有、有没有编）
```

规则：

1. 工程说明 → `docs/` 或根 `README` / `CHANGELOG`。
2. 进入检索的知识 → 仅 `knowledge/` 业务子目录；`_meta/` 不参与检索。
3. 展区/推荐问题/媒体映射 → `knowledge/_meta/zones.json`；同义词覆盖表 → `knowledge/_meta/synonyms.tsv`。
4. `server/.env`、`web/dist/`、`server/indexes/`、日志不入库。
5. 功能 Spec → `docs/compose/spec/<feature>.md`；被取代的旧文档 → `docs/archive/`，文件名带旧栈前缀（如 `old-node-`）。
6. 文档里的命令必须能在当前栈上直接跑通；旧栈命令只允许出现在 `archive/` 或明确标注的"待移植"说明里。
