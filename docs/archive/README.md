# 归档索引

本目录存放被取代的历史文档，**均不代表现状**，仅供追溯当时的约束与依据。归档文档里的命令、路径、数字与链接保留当时口径，不再维护；要了解现状请看 `CHANGELOG.md` 与各活文档（`docs/README.md`）。

命名规则：

- `old-node-*`：Node/Fastify + React 时代（2026-09 原地重写为 Spring Boot + Vue 3 之前）的产物。
- `eval/`：历史评测与标定产物（Node 与 Java 早期实跑报告）；当前基线/证据仍在 `docs/eval/`。

> 说明：早期的交接 / 审核 / 修复计划等过程快照（`2026-09-*` / `2026-10-*`）已随文档瘦身移除以精简仓库，其结论与依据均已在 `CHANGELOG.md` 留痕。

| 文件 | 内容 | 时效结论 | 现在的替身 |
|------|------|----------|------------|
| [old-node-spec-virtual-receptionist.md](./old-node-spec-virtual-receptionist.md) | Node 时代整体功能 Spec（虚拟讲解员总纲） | 已交付并重写为 Spring Boot，仅作决策依据 | `docs/architecture.md`、`docs/api.md` |
| [old-node-spec-reception-ux.md](./old-node-spec-reception-ux.md) | Node 时代接待交互 Spec | 同上 | `docs/{architecture,test-cases}.md`、`web/` |
| [old-node-spec-phase-a-hardening.md](./old-node-spec-phase-a-hardening.md) | Node 时代 Phase A 加固 Spec | 同上 | `CHANGELOG.md`、`docs/security*.md` |
| [old-node-spec-phase-b-c-quality-ops.md](./old-node-spec-phase-b-c-quality-ops.md) | Node 时代 Phase B/C 质量与运维 Spec | 同上 | `docs/eval.md`、`docs/optimization-backlog.md` |
| [eval/](./eval/) | 历史评测/标定报告（`baseline.json`、`retrieval-*.json`、早期 `calibration-*.json`、`probe-scores/ranking.json`） | 仅作证据留存，口径已过时 | `docs/eval/baseline-java.json`、`docs/eval.md` |
