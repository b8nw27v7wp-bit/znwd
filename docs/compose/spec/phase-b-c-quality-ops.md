---
feature: phase-b-c-quality-ops
status: delivered
updated: 2026-09-18
branch: feature/virtual-receptionist
commits: e900c6f..HEAD
---

# Phase B/C 回答质量与展览运营

## Report

**What was built** — 按 `plan.md` Phase B/C：检索评测集与脚本（top1 0.90 / top3 1.00，bag 基线）；同义词迭代；答案缓存 key 含 generation（K3）；`/api/admin/feedback-stats` 与 CSV；前端 zone 联动（URL/`znwdSetZone`）。C1/C2 的 openai_compat 代码路径已就绪，本机无内网 `.env`，接入步骤写在 `docs/eval.md`。C5/C6/E6 按需暂缓。

**Verification** — `npm run build -w server`/`-w web` PASS；unit **19/19**；`npm run eval:retrieval` 落盘 baseline（top1 0.90 / top3 1.00）；api-audit **21/21**。

**Journey log** — 无内网网关时评测只能 bag 基线，不以 mock 答案质量代替召回指标。负反馈分析依赖 feedback 可选 `question` 字段，避免与 chat 日志 hash 策略冲突。

## [S1] Problem

Phase A 已加固工程与安全，但缺检索质量度量、真实模型接入说明、展览 zone 闭环与反馈运营数据。

## [S2] Design

- **C3**：`server/eval/retrieval-cases.json`（≥30，含 zone/sourcePath 期望）；`npm run eval:retrieval` 输出 top1/top3 并写 `docs/eval/baseline.json`。
- **C1/C2**：不改业务 API；`EMBED_PROVIDER=|LLM_PROVIDER=openai_compat` + BASE_URL/KEY/MODEL；health 可验证 provider。
- **C4 + K3**：同义词扩展；`answerCacheKey(message, model, generation)`。
- **P2**：`GET /api/suggestions?zone=` 已有；前端读 `?zone=` 并暴露 `znwdSetZone`。
- **P3**：`GET /api/admin/feedback-stats[?format=csv]`；feedback `question` 可选。

## [S3] Out of Scope

- C5 PDF 入库、C6 指代改写、E6 向量库升级（规模上来再做）。
- 真实内网模型调通（需现场 `.env`）。

## Tasks

- [x] T1: 评测集 + 脚本 + baseline/docs/eval.md — acceptance: 可跑出 top1/top3 (covers: S2)
- [x] T2: C4 同义词 + K3 cache generation — acceptance: unit 覆盖；eval 可对比 (covers: S2)
- [x] T3: P2 zone 联动 + P3 feedback-stats — acceptance: suggestions?zone；admin CSV (covers: S2)
- [x] T4: C1/C2 配置文档与 .env.example 说明 — acceptance: eval.md 可照做接入 (covers: S2)
- [x] T5: 回归 build/unit/eval/audit + CHANGELOG — acceptance: 全绿 (covers: S2)
