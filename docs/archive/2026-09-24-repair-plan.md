# 后续修复计划

> **本文是 2026-09-24 的计划快照**：P1-2（会话归属）已实现、P0-1/P0-2 的黑盒链路已于
> 2026-09-29 实跑（冒烟 63/63、安全 98/0/1、库层 8/8、离线 7/7、内容验收 40/40，CI 已跑通）。
> 仍未完成的只有「在目标一体机上做开机自启/备份/断电重启演练」这一类必须到现场才能做的事。
> 当前状态以 `CHANGELOG.md` 顶部一节为准；本文保留 P0/P1/P2 的验收标准与依据。

更新时间：2026-09-24
适用分支：`feature/virtual-receptionist`

本计划承接 `./2026-09-24-hermes-handoff.md`。目标部署形态已明确为**单机一体机**：MySQL、知识库、向量索引、日志和缓存全部本机；只允许 LLM、embedding、可选 TTS/ASR 出网。目标是先消除发布阻断和契约歧义，再做真实一体机验证；不把尚未运行的集成测试写成“已通过”。

## P0：发布前必须完成

### P0-1 在 GitHub Actions 真实执行 CI

- 触发一次包含 backend/frontend job 的 CI，确认 YAML 不只是能解析，而是 runner 能启动 MySQL、初始化数据库并完成全部 step。
- 验证误配置实例确实没有继承 `ADMIN_TOKEN`，M01–M03 仍能验证 fail-closed。
- 验证 CI 中 `db-check.py` 因 `CI=true` 缺客户端/连库失败时返回非零，而不是假绿。
- 验收：Actions 中 `mvn test`、baseline eval、gate-check、package、smoke、security、db-check、frontend build/test、offline-check 全部通过；失败时日志能定位到对应实例。

### P0-2 在一体机上启动真实服务完成黑盒链路

先确认本机 MySQL 8+ 已启动并开机自启，`server/db/init.sql` 已执行，`.env` 使用 `DB_HOST=127.0.0.1` 和非 root 应用账号；正式验收不接受 `storageAvailable=false`。然后启动 jar、前端静态产物和安全实例，按顺序执行：

```bash
py -3 tools/smoke.py
py -3 tools/security.py
py -3 tools/db-check.py
```

- 主实例必须等待 `/api/health` 同时满足 `ok=true`、`ready=true`、`storageAvailable=true` 且 `knowledgeChunks>0`。
- security 的 `SECOND_BASE`、`MISCONFIG_BASE` 必须指向本机非回环地址；`ADMIN_TOKEN` 只传给有口令实例。
- security 与 db-check 不要并行，security 末尾会打满限流窗口。
- 验收：无 5xx、无密钥片段泄漏、SSE 序列正确、客户端断开不污染服务、库层脱敏和最小权限通过。

### P0-3 检查秘密与工作区交付边界

- 确认 `server/.env`、本地日志、数据库导出、向量索引和 `web/dist` 未被纳入提交。
- 对所有新增语音文件和 CI 修改执行人工 diff 审阅。
- 验收：交接后下一位开发者可以只依据 Git diff 重建变更，不依赖未说明的本机文件。

## P1：正确性与安全决策

### P1-1 定稿 HybridRetriever 兜底契约

> **状态：已决策——采用方案 A（允许语义新增候选），文档已同步**（`docs/architecture.md` §3、`docs/knowledge.md` §5、`docs/eval.md`、`docs/api.md`、`docs/test-cases.md`）。`SemanticRetrievalTest` 的类注释仍是旧表述（在 `server/` 下，未改）；`MIN_VECTOR_SCORE=0.75` 等效关闭兜底的说明不变。下面的两方案对照保留为决策依据。

当前代码在关键词未过闸门且语义命中达标时允许向量命中成为新候选；决策前文档和旧测试注释写成“只对关键词候选重排、不新增候选”。必须二选一：

**方案 A：保留当前行为（推荐先评估）**

- 语义向量只在关键词未过闸门时介入，避免普通关键词排序被 RRF 改写。
- 语义兜底可以带回关键词候选之外的语义相关块。
- 修改 `SemanticRetrievalTest`：增加“向量独有候选可以被救回”的断言，同时保留关键词过闸门时向量不得改排序的断言。
- 同步 `docs/architecture.md`、`docs/knowledge.md`、`docs/api.md`、`docs/optimization-backlog.md` 和评测说明。

**方案 B：严格遵守旧契约**

- 关键词候选非空时，向量只过滤/重排这些 ID，不引入新 ID。
- 关键词候选完全为空时明确拒答，或为完全无语义词命中场景单独设计并评测。
- 恢复/重写 `withinKeyword` 逻辑，并增加额外向量候选不得进入结果的测试。

- 验收：实现、`RetrievalDiagnostics.candidates`、`RetrievalMode`、API 文档和 eval 输出一致；`npm`/Maven 测试、eval、calibrate 全部通过。

### P1-2 会话读取/删除所有权

当前 `GET/DELETE /api/sessions/{id}` 只凭 sessionId 放行。先做产品决策：

- 单屏 kiosk、sessionId 不可猜：可暂时保留，但必须在部署文档中标明同一 LAN 的信任边界。
- 多用户或可被代理暴露：使用签名 cookie、短期会话票据或服务端 owner 绑定；不要仅依赖随机 ID。
- 保持换人时 `DELETE` 可用，不能简单把所有会话接口改成管理员 token。

验收：新增越权用例；合法换人流程仍能清上下文；日志和响应不泄露票据或消息内容。

### P1-3 一体机 MySQL 初始化、持久化与备份

- 固定 `DB_HOST=127.0.0.1`，不配置远程 MySQL、对象存储或远程日志服务。
- 将 MySQL 和应用 jar 注册为开机自启服务；验证重启机器后 `/api/health` 恢复 `storageAvailable=true`。
- 用 `server/db/init.sql` 创建 `znwd@localhost` 最小权限账号；应用账号不能执行 DROP/ALTER/GRANT。
- 确认 `server/data/`、`server/indexes/`、`knowledge/` 和 `.env` 在本机备份策略内；不把数据库导出和 `.env` 放进 Git。
- 若将来迁移到远程库，再单独启用 `DB_SSL_MODE=VERIFY_IDENTITY`，不要把远程 TLS 假设带进当前本机档位。
- 验收：断电/重启后知识、会话、统计和未覆盖问题仍可恢复；health 在库故障时如实报 unavailable，恢复后自动重连。

### P1-4 检查脚本的 fail-closed 语义

- `db-check.py` 已支持 `CI`/`DB_CHECK_STRICT`，为本地缺 mysql 客户端保留显式 SKIP 模式。
- 审核 `security.py` 中关键 S10、S16–S18、M01–M03、Y 组跳过是否在 CI 中全部变成失败；语音未启用的 Y01–Y06 是否仍允许按设计降级为 SKIP。
- 统一退出码和汇总，避免“失败列表为空但关键测试没有执行”。
- 验收：在故意缺服务、缺 token、缺事件日志的故障注入下返回非零；正常本地可选模式有清晰提示。

### P1-5 阈值与评测基线治理

- 任何语料、同义词、embedding 模型或分块变更，先跑 `eval` 与 `calibrate --gate-check`。
- 保持 `MIN_RELEVANCE_SCORE` 和 `MIN_VECTOR_SCORE` 在 `server/.env`、`application.yml`、Java 默认常量、CI 四处一致。
- 重新生成 baseline 前先人工审阅逐例差异，禁止为了让 CI 变绿直接覆盖 baseline。
- 验收：top1/top3、gateBlockedCount、域外关键词分、域外余弦均有记录；阈值变更附评测依据。

### P1-6 一体机运行与开机自愈

- 将 MySQL、后端 jar、前端静态服务器配置为开机自启，并设置工作目录、环境文件和日志轮转。
- 一体机浏览器优先访问 `http://127.0.0.1`，避免把管理接口暴露到局域网；如必须跨机访问，再单独做反代、防火墙和真实来源 IP 配置。
- 增加进程守护/健康巡检：进程退出自动拉起，连续 health 失败时记录原因；不能只看进程存在。
- 做一次真实重启演练，确认 MySQL 先于应用恢复、知识索引可用、日志继续轮转。
- 验收：断电重启后无需人工登录或手工执行 SQL 即可恢复展厅讲解。

## P2：集成、观测和性能

### P2-1 真实依赖与断网验证

一体机允许模型/语音出网，但要分别验证正常和断网场景：

- 正常出网：LLM、embedding、MiMo TTS/ASR 的真实响应。
- 模型/embedding 断网：服务仍能启动，知识检索退回关键词路，health 报出降级原因。
- 语音断网：TTS 退回浏览器合成，ASR 隐藏/禁用，键盘问答不受影响。
- 本机 MySQL 断网/重启：不依赖远程数据库，恢复后自动重连。
- 反向代理仅在跨机访问场景验证；同机 kiosk 优先使用 `127.0.0.1`。

分别在受控环境验证：

- OpenAI-compatible LLM：超时、HTTP 200 错误体、空 SSE、缺 `[DONE]`、超长输出、并发 usage。
- Embedding：构建失败、查询失败、维度变化、索引 reload、冷却期间关键词降级。
- MiMo TTS/ASR：二进制 WAV、缓存命中、上游 4xx/5xx、响应体大小、取消和浏览器无语音权限降级。
- 反向代理：SSE 不缓冲、请求体上限、客户端断开、真实来源 IP 和管理鉴权。

### P2-2 负载与资源上限

- 对 chat、SSE、embedding 查询、管理诊断和语音缓存做并发/长文本压测。
- 记录响应体上限、线程池、HTTP client 连接池、缓存大小和日志写盘峰值。
- 验收：达到设定负载时返回可判定的 429/503/timeout，不出现 OOM、线程泄漏或磁盘无界增长。

### P2-3 清理文档漂移

- 对照 OpenAPI、前端类型、后端响应和 `docs/api.md` 做一次契约 diff。
- 删除或修正“向量只重排关键词候选”“SKIP 不算通过”等与实现不一致的表述。
- 更新 README/部署文档中的 Java、MySQL、模型、语音和端口版本信息。

## 推荐执行顺序

1. P0-1、P0-2：先让 CI 和黑盒链路真实跑通。
2. P1-1：立即决定 RAG 契约，避免下一轮继续在互相矛盾的文档上开发。
3. P1-2、P1-3：补齐会话所有权和一体机本机 MySQL 的持久化/自启边界。
4. P1-4、P1-5：收紧检查脚本和评测基线治理。
5. P2：真实依赖、压测、文档漂移清理。
6. 最后再审阅全部 diff、决定是否拆分提交；不要在本计划阶段自动 commit。

## 完成定义

- CI 远端运行通过，失败注入不会假绿。
- 本地单元/前端测试、构建、离线检查、eval、calibrate、smoke、security、db-check 均有可复现记录。
- RAG 兜底行为、API 字段、health 状态和文档一致。
- 会话访问模型明确，且本机 MySQL 初始化、开机自启、备份恢复要求可部署。
- 所有秘密、生成物、探测数据和本地运行目录均不进入版本库。
- `git status`、测试报告和交接文档与最终源码一致。

## 常用命令

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
```

PowerShell 下 `exec:java` 的 `-Dexec.args` 要整体使用单引号；CI 的 Bash 写法保持双引号即可。
