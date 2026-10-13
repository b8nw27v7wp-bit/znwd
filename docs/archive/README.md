# 归档索引

本目录存放被取代的历史文档，**均不代表现状**，仅供追溯当时的约束、依据与执行记录。归档文档里的命令、路径、数字与链接保留当时口径，不再维护；要了解现状请看 `CHANGELOG.md` 与各活文档（`docs/README.md` 的文档一览）。

命名规则：

- `old-node-*`：Node/Fastify + React 时代（2026-09 原地重写为 Spring Boot + Vue 3 之前）的代码审查 / 审计 / 交接计划。
- `2026-09-*` / `2026-10-*`：Java 重写期间的历史快照，前缀是快照产生日期（交接、审核、修复计划）。

| 文件 | 内容 | 时效结论 | 现在的替身 |
|------|------|----------|------------|
| [old-node-plan.md](./old-node-plan.md) | Node 时代后端优化计划与交接（2026-09-17/18） | 已过时，命令与路径不适用 | `CHANGELOG.md`、`docs/development.md`、`docs/architecture.md` |
| [old-node-code-review.md](./old-node-code-review.md) | Node 时代代码排查记录（2026-09-17） | 已过时 | `CHANGELOG.md`、`docs/security-testing.md` |
| [old-node-code-audit.md](./old-node-code-audit.md) | Node 时代代码审计与功能测试报告（0.8.0 → 0.9.0） | 已过时 | `CHANGELOG.md`、`docs/security-testing.md` |
| [2026-09-22-speech-plan.md](./2026-09-22-speech-plan.md) | 语音播报「没启动」修复计划（P0/P1/P2 已修复并复验） | 已完结，根因分析保留作依据 | `CHANGELOG.md`、`docs/architecture.md`、`docs/api.md` |
| [2026-09-24-hermes-handoff.md](./2026-09-24-hermes-handoff.md) | 交接快照：工作区状态、不可破坏契约、本轮已做修复 | 已被后续改动取代（2026-09-29 落地并复跑） | `CHANGELOG.md`、`docs/{development,api,security-testing,eval}.md` |
| [2026-09-24-repair-plan.md](./2026-09-24-repair-plan.md) | 发布前修复计划：P0/P1/P2 验收标准与执行顺序 | 任务多数已落地，现场演练类仍需到目标一体机执行 | `CHANGELOG.md`、`docs/{development,security-testing,eval}.md` |
| [2026-09-24-code-review-handoff.md](./2026-09-24-code-review-handoff.md) | 代码审核交接：审核状态总表、测试缺口与结论 | 审核表已于 2026-09-29 复核，缺口已补 | `CHANGELOG.md`、`docs/{security-testing,test-cases}.md` |
| [2026-10-12-voice-realtime-p1-plan.md](./2026-10-12-voice-realtime-p1-plan.md) | 第 3 档 P1（滚动识别 + 常开聆听 + 声学遥测）实施计划与逐条验收清单 | 代码已按此实施完毕（2026-10-12）；展厅声学实测与「服务端复核端点检测」未做 | `CHANGELOG.md`、`docs/api.md`、`docs/voice-realtime-plan.md` |
