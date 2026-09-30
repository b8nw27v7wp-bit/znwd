# Hermes 交接记录

> **本文是 2026-09-24 的工作区快照，其中的「未验证项」「工作区不干净」等结论已被后续改动取代**
> （那份未提交的改动已于 2026-09-29 全部落地并复跑）。当前状态以 `CHANGELOG.md` 顶部的
> 「未发布 — 2026-09-29」一节与各活文档（`docs/{development,api,security-testing,eval}.md`）为准；
> 本文保留下来是因为它记录了当时的约束与取舍依据。

更新时间：2026-09-24

## 1. 工作区状态

- 仓库：`E:\znwd`
- 分支：`feature/virtual-receptionist`
- 当前基线提交：`c4e2db4 feat(rag+knowledge): 语义向量接云端 bge-m3、语料按原文溯源收口并补全（1.2.0 → 1.3.0）`
- 本轮没有创建 commit。
- 工作区不是干净快照：包含本轮修复、上一轮 Hermes 改动和语音相关未跟踪文件。不要执行 `git reset --hard`、`git checkout -- .` 或清理未跟踪文件。
- 当前 tracked diff 约 68 个文件，另有语音/前端组合式函数等未跟踪目录与文件；提交前必须逐项审阅，不要按目录整体回滚。

## 2. 用户约束与不可破坏契约

- 技术栈：Spring Boot/Java 21 目标、Vue 3/TypeScript/Vite、MySQL、Hybrid RAG、服务端/浏览器语音降级。
- SSE 对外契约：`meta → delta* → done`；`done.answer` 必须非空；客户端断开会取消请求并清理代际状态。
- 知识库未 ready 或检索失败时必须 fail-closed，不返回伪造的“资料没有”或空成功响应。
- 管理接口默认要求 `ADMIN_TOKEN`；非回环来源不能因为服务绑定 `0.0.0.0` 而绕过鉴权。
- 当前部署目标：**单一体机**。MySQL 使用 `127.0.0.1`，知识库、向量索引、日志和缓存全部本机；不使用远程 MySQL、对象存储或远程日志服务。
- 仅允许 LLM、embedding、可选 TTS/ASR 出网；这些服务不可用时必须按部署文档降级。
- 当前检索阈值：`MIN_RELEVANCE_SCORE=6.3`、`MIN_VECTOR_SCORE=0.75`；四个配置入口必须同步修改。
- 不提交密钥、API key、数据库密码或生成的本地运行数据。

## 3. 本轮已完成的代码修复

### 鉴权与配置

- `AdminGuard` 使用请求来源 `remoteAddr`，不再使用 `HttpServlet.getLocalAddr()` 判断客户端。
- `application.yml` 将 `REQUIRE_ADMIN_TOKEN` 默认值设为 `true`。
- 管理口令失败增加按来源限流；管理控制器和相关测试已同步。
- `DotEnvPropertySource` 支持行内注释；`.env.example` 修复阈值和 `DB_PASSWORD` 行内注释。
- MySQL URL 支持 `DB_SSL_MODE` 与 `DB_ALLOW_PUBLIC_KEY_RETRIEVAL`。
- CORS、OpenAPI、健康接口和 `ready` 语义已同步文档与契约。

### LLM、缓存与流式响应

- `OpenAiCompatChatModel` 增加非流式/流式响应体上限、输出上限、HTTP 200 业务错误处理、严格 SSE 终止帧、总 deadline 和流 watchdog。
- `lastUsage` 改为请求级 `ThreadLocal`，避免并发污染 token 统计。
- 答案缓存键改为完整规范化问题的 SHA-256，不再使用 300 字截断键。
- SSE 客户端断开、空流、错误帧和超时均有明确清理路径。

### RAG 与知识库

- 向量索引升级为版本 2，记录 provider/model/endpoint/dims/语料指纹，并校验索引版本、维度和有限值。
- 查询期向量化增加冷却与单线程探测，外部 embedding 故障时降级到关键词路。
- `KnowledgeLoader`、`KnowledgeService` 对空知识库、读取失败、reload 指纹竞态采取 fail-closed/原子快照处理。
- `TextChunker` 保证中等长度单段也受字符上限约束。
- 关键词过闸门时跳过外部向量查询；health 和 retrieval diagnostics 如实报告降级状态。

### 数据库、会话与前端

- `DatabaseStatus` 增加失败状态、并发探活保护和建表失败处理。
- `SessionStore` 使用分片锁、单调序号、过期清理和恢复失败标记；`SessionMapper` 按 `seq,id` 恢复顺序。
- `api.ts` 增加 API base 环境变量、请求超时、Abort 处理、严格 SSE 状态机和更安全的 session ID。
- `useChat` 增加 reset 门闩、流代际隔离、反馈失败回滚。
- `useSpeech` 增加取消、预取取消、失败降级、播放 watchdog 和延迟 warmup。
- `useDictation` 处理麦克风授权竞态、pending 状态和卸载清理。
- `AdminPanel` 对非 2xx 和过期响应做保护。
- `App.vue` 已删除重复的 `chat.cancel()`，保留一次卸载取消。

### CI 与检查脚本

- 修复 `.github/workflows/ci.yml` 检索评测步骤的 YAML 缩进。
- CI readiness 同时断言 `storageAvailable=true`、`ready=true`、`ok=true` 和知识块非零。
- CI 误配置实例使用 `env -u ADMIN_TOKEN`，避免继承 step 级 token。
- `tools/db-check.py` 在 `CI=true` 或 `DB_CHECK_STRICT=true` 时把缺客户端、连库失败和关键跳过视为失败；本地仍可显式跳过。
- `tools/offline-check.py` 允许 LLM、embedding、MiMo 语音三个适配器出网。
- 检索评测 CI 命令加入 `docs/eval/baseline-java.json` 逐例基线比较。

## 4. 已执行验证

| 命令 | 结果 |
| --- | --- |
| `server: mvn -B clean test` | 123 tests，0 failures，0 errors，0 skipped |
| `web: npm test` | 9 files，104 tests passed |
| `web: npm run build` | `vue-tsc -b` 与 `vite build` 通过 |
| `py -3 tools/offline-check.py` | O01–O05 通过；O06/O07 因未加 `--runtime` 按设计跳过 |
| `mvn -B -q test-compile exec:java@eval '-Dexec.args=--no-write --baseline=docs/eval/baseline-java.json'` | 145 条计分用例 top1/top3 均 1.0；与 baseline 逐例不一致数为 0 |
| `mvn -B -q test-compile exec:java@calibrate '-Dexec.args=--gate-check --no-write'` | 退出码 0；关键词和语义域外余弦门禁未越线 |
| PyYAML 解析 `.github/workflows/ci.yml` | 通过 |
| `py -3 -m py_compile tools/db-check.py tools/security.py tools/offline-check.py tools/smoke.py` | 通过 |
| `git diff --check` | 无 whitespace 错误；Git 仅提示 Windows 工作区 LF/CRLF 转换 |

标定输出仍提示“在域最低分/域外最高分的可分区间不成立”，这是当前语料的已知现象；CI 采用排序分口径的域外越线门禁，而不是把区间不成立直接判为失败。当前 `MIN_VECTOR_SCORE=0.75` 实际上关闭了向量兜底。

## 5. 尚未验证

- 没有在本轮启动真实 HTTP 服务，因此没有执行 `tools/smoke.py`、完整 `tools/security.py` 或 `tools/db-check.py` 黑盒流程。
- 没有验证真实反向代理、网络断开、云端 LLM、云端 embedding、MiMo TTS/ASR。
- 没有在一台干净的一体机上从零执行 MySQL 初始化、开机自启、jar/前端启动和重启恢复演练。
- GitHub Actions 只做了 YAML 解析和本地等价命令验证，尚未在远端 runner 执行。
- 会话接口目前仍按“知道 sessionId 即可读取/删除”的展厅单机设计工作；客户端 ID 已增强随机性，但没有真正的所有权/签名机制。
- 本机 MySQL 部署应保持 `DB_HOST=127.0.0.1`；`DB_SSL_MODE=DISABLED` 仅适用于本机回环，未来迁移远程库时再单独启用严格 TLS。
- `HybridRetriever` 兜底路径允许语义命中成为新候选。**已决策：允许语义新增候选，文档已同步**（按「文档对齐代码」定稿）：`docs/architecture.md`、`docs/knowledge.md` 已改写为该契约，不再把“只重排关键词候选、不新增候选”当现行表述；`SemanticRetrievalTest` 的类注释仍是旧说法（在 `server/` 下，本轮未改）。`MIN_VECTOR_SCORE=0.75` 实际关闭了向量兜底，这一说明保持不变。

## 6. 关键文件入口

- 安全：`server/src/main/java/com/znwd/hostess/web/AdminGuard.java`、`application.yml`、`docs/security.md`。
- LLM/SSE：`server/src/main/java/com/znwd/hostess/llm/OpenAiCompatChatModel.java`、`web/src/api.ts`。
- 检索：`server/src/main/java/com/znwd/hostess/knowledge/{HybridRetriever,VectorStore,KnowledgeLoader,TextChunker}.java`、`docs/eval.md`。
- 会话/数据库：`server/src/main/java/com/znwd/hostess/{repository/DatabaseStatus,session/SessionStore,repository/SessionMapper}.java`。
- 前端语音：`web/src/composables/{useSpeech,useDictation}.ts`、`web/src/App.vue`、`server/src/main/java/com/znwd/hostess/audio/`。
- CI/工具：`.github/workflows/ci.yml`、`tools/{offline-check,security,db-check,smoke}.py`。
- 评测基线：`docs/eval/baseline-java.json`、`server/eval/retrieval-cases.json`。

## 7. 下一对话建议入口

1. 先运行 `git status --short`，确认不要覆盖语音未跟踪文件。
2. 阅读本文件和 `./2026-09-24-repair-plan.md`，再决定是否调整 RAG 兜底契约。
3. 若调整 RAG，先改实现和 `SemanticRetrievalTest`，再同步 `docs/architecture.md`、`docs/knowledge.md`、`docs/optimization-backlog.md`，最后跑 eval/calibrate。
4. 若处理会话安全，先确定产品是单屏 kiosk 还是多用户，再选择签名 cookie、管理员 token 或服务端绑定；不要直接给 DELETE 套管理员 token 而破坏前端换人流程。
5. 在目标一体机上先启动本机 MySQL 并确认 `storageAvailable=true`，再按顺序跑 `smoke.py`、`security.py`、`db-check.py`；不要并行运行 security 和 db-check，避免限流污染结果。
6. 现场只允许 LLM/embedding/可选 TTS/ASR 出网；用 `offline-check.py --runtime` 验证出网白名单与降级状态。
