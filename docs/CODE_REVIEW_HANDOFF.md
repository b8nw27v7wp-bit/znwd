# 代码审核交接文档

> **本文的审核表已在 2026-09-29 复核并更新状态**（会话归属由「未修复，已接受风险」改为已实现；
> 前端项数 104 → 134）。真实环境验收这一项也已补齐：黑盒三件套 + 内容验收 + 远端 CI 均已实跑，
> 证据与口径见 `CHANGELOG.md` 顶部的「未发布 — 2026-09-29」一节。仍未验证的只有目标一体机上的
> 开机自启/备份/断电重启演练。

更新时间：2026-09-24（状态行于 2026-09-29 复核）
适用分支：`feature/virtual-receptionist`
基线提交：`c4e2db4`

## 1. 审核结论

本轮代码审核已完成本地修复和回归验证，但**尚未完成真实环境验收**。

- 目标部署是**单一体机**：MySQL、知识库、向量索引、日志和缓存全部本机；不使用远程 MySQL、对象存储或远程日志服务。
- 仅允许 LLM、embedding、可选 TTS/ASR 出网；模型或语音不可用时必须按降级规则工作。
- 本地编译、单元测试、前端测试、构建、离线不变量、检索评测和阈值门禁均通过。
- 真实服务黑盒测试、GitHub Actions 远端执行、真实云端模型/embedding/TTS/ASR 和目标一体机重启恢复尚未验证。
- 工作区保留大量未提交修改和未跟踪语音文件；不要执行全量回滚或清理未跟踪文件。
- 详细执行记录见 `docs/HERMES_HANDOFF.md`，任务拆分见 `docs/REPAIR_PLAN.md`。

## 2. 审核状态总表

| 级别 | 问题 | 状态 | 证据/后续 |
| --- | --- | --- | --- |
| P0 | CI workflow YAML 缩进错误 | 已修复，待远端验证 | `.github/workflows/ci.yml` 已通过 YAML 解析；需跑 Actions |
| P0 | CI readiness 只等端口、不等 ready | 已修复 | 冒烟步骤断言 `ok/ready/storageAvailable/knowledgeChunks` |
| P0 | 误配置实例继承 `ADMIN_TOKEN`，无法验证 fail-closed | 已修复 | CI 误配置实例使用 `env -u ADMIN_TOKEN` |
| P0 | `db-check.py` 缺客户端/连库失败时返回成功 | 已修复 | `CI=true` 或 `DB_CHECK_STRICT=true` 时严格失败 |
| P1 | 管理鉴权按 `localAddr` 判断客户端 | 已修复 | 改用 `remoteAddr`；`AdminGuard` 相关测试通过 |
| P1 | 管理鉴权默认放行 | 已修复 | `REQUIRE_ADMIN_TOKEN` 默认 `true`；增加失败限流 |
| P1 | LLM/SSE 响应体、输出长度和 deadline 无上限 | 已修复 | 响应体/输出上限、HTTP 200 业务错误、watchdog、`[DONE]` 校验 |
| P1 | 并发 usage 统计互相污染 | 已修复 | `ThreadLocal` 请求上下文；并发/超时测试通过 |
| P1 | 答案缓存键截断导致错误命中 | 已修复 | 完整规范化问题 SHA-256 |
| P1 | 向量索引缺少身份/维度/语料校验 | 已修复 | 索引 v2、provider/model/endpoint/dims/指纹校验、查询冷却 |
| P1 | 知识库空/加载失败时静默继续 | 已修复 | `KnowledgeLoader`/`KnowledgeService` fail-closed，快照原子替换 |
| P1 | 会话恢复顺序、并发写和清理不可靠 | 已修复 | 分片锁、单调 seq、按 seq 恢复、过期清理、失败状态 |
| P1 | 前端 SSE 状态机、Abort、reset、TTS 竞态 | 已修复 | 前端 134 项测试与构建通过（2026-09-29 复核） |
| P1 | 会话 GET/DELETE 无所有权校验 | **已修复（2026-09-29）**：问答响应下发 `sessionToken`，`GET/DELETE` 用 `X-Session-Token`（或 `?sessionToken=`）校验，不匹配回 404 | `ChatWebContractTest` 4 条单测；`tools/security.py` S19/S19a–d 实测 404/404/200/200；残留取舍（令牌即所有权）记在 `docs/security-testing.md` |
| P1 | 语义兜底是否允许新增候选，代码与文档契约不一致 | **已决策：允许语义新增候选，文档已同步** | 按「文档对齐代码」定稿：`HybridRetriever` 保持允许，`docs/architecture.md`/`docs/knowledge.md` 已改写；`MIN_VECTOR_SCORE=0.75` 仍等效关闭兜底（测试注释待 `server/` 侧同步） |
| P1 | 一体机 MySQL 初始化、开机自启、备份恢复未在目标机验证 | **未验证** | 固定 `DB_HOST=127.0.0.1`；先执行 `server/db/init.sql`，正式验收要求 `storageAvailable=true` |
| P2 | 真实反代/云模型/语音/数据库链路未验证 | 待验证 | 需按修复计划 P0-2、P2-1 执行 |
| P2 | 语音、负载、资源上限和长期运行未压测 | 待验证 | 见修复计划 P2-2 |
| P2 | 文档与实现存在版本/契约漂移 | 部分修复 | 交接文档已记录，下一轮需做契约 diff |

## 3. 已完成修改分类

### 后端安全与 HTTP

- `AdminGuard`、管理控制器、`StatusController`、`GlobalExceptionHandler`。
- `RequestSizeLimitFilter`、CORS、`nosniff`、统一错误信封。
- `DotEnvPropertySource`、MySQL SSL 参数、OpenAPI 契约。

### 后端数据与检索

- `VectorStore`、`HybridRetriever`、`Retriever`、`Synonyms`、`TextChunker`。
- `KnowledgeLoader`、`KnowledgeService`、`ChatRunService`、`RagPipeline`。
- `DatabaseStatus`、`SessionStore`、`SessionMapper`、`Analytics`。
- `OpenAiCompatChatModel`、`LruCache`、`JsonlStore`。

### 前端

- `web/src/api.ts`：API base、超时、Abort、SSE 严格状态机、随机 session ID。
- `web/src/composables/useChat.ts`：reset 门闩、流代际隔离、反馈回滚。
- `web/src/composables/useSpeech.ts`、`useDictation.ts`：TTS/ASR 取消、降级、看门狗、授权竞态。
- `web/src/App.vue`、`AdminPanel.vue`、`storage.ts`：卸载清理、响应校验、存储封装。

### 工具与 CI

- `.github/workflows/ci.yml`：YAML、readiness、实例隔离、baseline eval。
- `tools/db-check.py`：严格模式。
- `tools/offline-check.py`：LLM/embedding/语音白名单。
- `docs/api.md`、`docs/architecture.md`、`docs/deployment.md`、`docs/security*.md` 等。

## 4. 可复现验证记录

```powershell
cd E:\znwd\server
mvn -B clean test
mvn -B -q test-compile exec:java@eval '-Dexec.args=--no-write --baseline=docs/eval/baseline-java.json'
mvn -B -q test-compile exec:java@calibrate '-Dexec.args=--gate-check --no-write'

cd E:\znwd\web
npm test
npm run build

cd E:\znwd
py -3 tools/offline-check.py
py -3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml', encoding='utf-8'))"
```

已取得的结果：

- 后端：123 tests，0 failures，0 errors，0 skipped。
- 前端：9 个测试文件，104 tests passed。
- 前端构建：`vue-tsc -b` + `vite build` 通过。
- eval：145 条计分用例 top1/top3 均为 1.0，baseline 逐例不一致数为 0。
- calibrate gate-check：退出码 0；域外关键词分与语义余弦未越线。
- 离线检查：O01–O05 通过；O06/O07 因未加 `--runtime` 按设计跳过。
- `git diff --check`、CI YAML 解析、Python 脚本语法检查通过。

## 5. 审核遗留风险

1. **不能把本地测试当作集成验证**：本轮没有启动 HTTP 服务，因此 `smoke.py`、`security.py`、`db-check.py` 尚未产生本轮结果。
2. **CI 尚未在 runner 上执行**：本地 YAML 解析只能证明语法，不证明 MySQL service、`env -u`、端口探测和脚本顺序在 Ubuntu runner 上正常。
3. **语义兜底契约已定稿**：当前 `HybridRetriever` 在关键词未过闸门时可能把向量独有候选带入结果——已决策「允许语义新增候选、文档对齐代码」，`docs/architecture.md`、`docs/knowledge.md` 已同步（`MIN_VECTOR_SCORE=0.75` 仍等效关闭兜底）。
4. **会话访问模型仍是单屏假设**：随机 ID 降低猜测概率，但不是访问控制。
5. **阈值区间警告仍存在**：标定显示在域最低分与域外最高分的可分区间不成立；当前依靠 6.3 的排序分口径守住域外门禁，语料变化后必须重标定。
6. **一体机本机 MySQL 尚未做干净机演练**：需要验证开机自启、`.env` 权限、`init.sql` 幂等性、断电重启后的会话/统计恢复和本机备份恢复；不涉及远程数据库 TLS。

## 6. 审核通过条件

下一轮只有在以下条件满足后，才可将本轮标记为“可发布”：

- 远端 CI 完整通过，且故障注入不会假绿。
- 主实例、误配置实例和库层黑盒测试通过。
- 语义兜底契约在代码、测试、API 和架构文档中一致。
- 会话访问模型已明确；本机 MySQL 初始化、开机自启和备份恢复已有记录。
- 真实模型、语音、反代和负载验证有记录。
- 全部 diff、秘密扫描和生成物清理完成。

## 7. 交接动作

- 不要执行 `git reset --hard`、`git checkout -- .` 或删除未跟踪语音文件。
- 下一对话先读本文件、`docs/HERMES_HANDOFF.md`、`docs/REPAIR_PLAN.md`。
- 若继续修复，优先处理 P0-1/P0-2，再处理 RAG 契约和会话所有权。
- 本文件不包含密钥；任何 `.env`、token、数据库导出和本地索引都不得复制到文档或提交。
