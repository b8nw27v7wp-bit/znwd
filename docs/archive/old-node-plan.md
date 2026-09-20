# 项目后端优化 Plan（交接文档 · 已归档）

> **本文件已归档**：它描述的是 **Node/Fastify + React** 时代的实现与优化计划，其中的命令、文件路径
> 与现状不符。当前技术栈（Spring Boot + Vue 3）的现状看 `docs/README.md`、`README.md` 与
> `docs/optimization-backlog.md`；这里只作为那一轮工作的历史记录保留。

> 生成日期：2026-09-17（第二轮加固于 2026-09-18 追加，见 §11）  
> 仓库：`E:\znwd`  
> 分支：`feature/virtual-receptionist`（HEAD 约 `05a65e3`）  
> 用途：**新会话直接按本文档推进**；实现细节以代码为准。

---

## 0. 项目快照（给新会话）

| 项 | 现状 |
|----|------|
| 业务 | 产品展厅 AI 虚拟讲解：**光伏清洁无人机 / 风场检测无人机** |
| 形态 | 浏览器大屏；**左约 1/3** CSS 占位形象 + 下方对话；TTS 朗读 |
| 后端 | Node.js + Fastify + TS monorepo（`server/`） |
| 检索 | Hybrid：关键词 bigram + 向量（默认 `bag` 哈希，可切 `openai_compat`）+ RRF |
| LLM | 默认 `mock`（grounded 摘要）；可切 `openai_compat` |
| 会话 | 内存 `SessionStore`（6 轮 / TTL 10min） |
| 已有增强 | SSE `/api/chat/stream`、答案 LRU、JSONL 日志、同义词扩展、限流、可选 `ADMIN_TOKEN` |
| 测试 | `npm test -w server`（10 用例）；`node server/scripts/api-audit.mjs`（20 项，需先起 server） |
| 文档 | `docs/README.md`、`api.md`、`knowledge.md`、`code-review.md`、`code-audit.md` |

**本地启动**

```bash
npm install
npm run dev:server    # :8787
npm run dev:web       # :5173
npm test -w server
node server/scripts/api-audit.mjs
```

**知识目录**

```
knowledge/
  _meta/zones.json
  01_光伏清洁无人机/
  02_风场检测无人机/
  03_服务与合作/
  90_通识/
```

**关键配置（`server/.env`）**

- `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`
- `EMBED_PROVIDER`（`bag` \| `openai_compat`）/ `EMBED_MODEL`
- `ADMIN_TOKEN`、`CHAT_RATE_PER_MIN`、`ANSWER_CACHE_SIZE`
- `DATA_DIR`（JSONL）、`INDEX_DIR`（向量索引）、`KNOWLEDGE_WATCH`

---

## 1. 能力层（回答质量）

### 缺点

1. 默认 `EMBED_PROVIDER=bag` 为特征哈希，**不是语义向量**，Hybrid 名实不符。  
2. 默认 **Mock LLM**：只能从检索片段拼答案，不能推理、改写、要参数。  
3. **无检索评测集**：无法证明换知识/换模型后召回是否退化。  
4. 中文检索依赖 **bigram + 手写同义词**（`server/src/knowledge/synonyms.ts`），覆盖面小。  
5. 知识仅支持 **`.md`/`.txt`**，真实资料（PDF/Word）进不来。  
6. 多轮只把 history 塞进 prompt，**无指代消解/问题改写**。

### 优化建议

| ID | 建议 | 优先级 | 验收 |
|----|------|--------|------|
| C1 | 配置 `EMBED_PROVIDER=openai_compat` + 内网中文向量模型（如 bge-small-zh）；文档写清接入步骤 | P0 | health 显示 embed 非 bag；同语义问法命中提升 |
| C2 | 配置 `LLM_PROVIDER=openai_compat`；Mock 仅作离线兜底 | P0 | 回答不再带「Mock 演示回复」 |
| C3 | 新建 `server/eval/retrieval-cases.json`（≥30 条：question → 期望 sourcePath/zone）+ `npm run eval:retrieval` 输出 top1/top3 命中率 | P0 | 脚本可跑出命中率；baseline 写入 `docs/code-audit.md` 或新 `docs/eval.md` |
| C4 | 扩展 synonyms；或引入轻量分词词典；评测集驱动迭代 | P1 | 评测命中率相对 baseline 可比 |
| C5 | loader 增加 PDF（可选 pdftotext/python 转换流水线）；知识运营文档说明 | P2 | 示例 PDF 可入库并被 chat 命中 |
| C6 | 多轮：有 history 时先「改写为完整问题」再检索（规则或小模型） | P2 | 评测集中指代类 query 命中提升 |

### 相关文件

- `server/src/embedding/*`、`server/src/knowledge/hybridRetriever.ts`、`vectorStore.ts`
- `server/src/rag/pipeline.ts`、`server/src/llm/*`
- `server/src/knowledge/synonyms.ts`、`loader.ts`

---

## 2. 工程与运维层

### 缺点

1. 会话/统计 **内存态**，重启即丢。  
2. 向量索引为 **JSON 全量文件**，`search` O(n)，大库慢。  
3. `knowledge reload` **非原子**，与并发 `retrieve` 可能混用新旧数据。  
4. JSONL **记录完整 question**，无脱敏、无轮转、无大小上限。  
5. **无优雅退出**（SIGTERM/SIGINT 清理）。  
6. 限流 **进程内 Map**，多实例/重启失效。  
7. `KNOWLEDGE_WATCH` 依赖 `fs.watch recursive`，Windows 上不稳定且默认关。  
8. **无 CI**；测试需手动跑。  
9. SSE 与 `/api/chat` **业务逻辑两套**，易漂移。

### 优化建议

| ID | 建议 | 优先级 | 验收 |
|----|------|--------|------|
| E1 | 抽 `runChat({ message, sessionId })`：检索→LLM→会话→日志→缓存，chat/SSE 共用 | P0 | 两接口行为一致；单测可测 runChat |
| E2 | `HybridRetriever` 加 **generation/版本号**：`replace` 时 +1；`retrieve` 读到旧代则重读或重载 | P0 | reload 并发 chat 不混用脏数据（压测/单测） |
| E3 | 日志：仅存 **hash/截断** 的 messagePreview；`DATA_DIR` 文件按日轮转 + `maxBytes` | P1 | events.jsonl 不超限；无完整敏感长文 |
| E4 | `process.on('SIGTERM')`：`app.close`、等待 JsonlStore chain、再 `exit` | P1 | kill 后日志完整、端口释放 |
| E5 | 会话持久化可选：启动从 `data/sessions.json` 恢复（或后续 SQLite） | P1 | 重启后同 sessionId 仍可 peek（可配开关） |
| E6 | 向量：中小规模改 **per-chunk 文件/SQLite** 或内存 + 异步原子写（临时文件 rename） | P2 | 1k+ chunk 检索延迟可接受；写索引不半文件 |
| E7 | 限流可选 Redis；无则文档写明单机局限 | P2 | 文档 + 默认仍内存 |
| E8 | CI：GitHub Actions/本地脚本 `build + unit + api-audit`（server 起停） | P1 | 一键脚本/流水线绿 |
| E9 | Knowledge 手动 reload 为唯一热更路径；watch 标为 experimental | P2 | README/`.env.example` 说明 |

### 相关文件

- `server/src/index.ts`、`routes/chat.ts`、`rag/pipeline.ts`
- `server/src/http/cache.ts`（JsonlStore）
- `server/src/knowledge/hybridRetriever.ts`、`vectorStore.ts`
- `server/src/session/store.ts`

---

## 3. 安全与边界层

### 缺点

1. **`ADMIN_TOKEN` 未配置时** stats/reload 完全开放。  
2. 默认 **`HOST=0.0.0.0`**，对全网卡监听。  
3. **无 HTTPS、无终端鉴权**（展厅同网段可调 API）。  
4. 500 响应可能带 **内部 `err.message`**。  
5. **CORS `origin: true`** 任意源可调。  
6. 无设备/班次级 **审计身份**，只有 IP + sessionId。

### 优化建议

| ID | 建议 | 优先级 | 验收 |
|----|------|--------|------|
| S1 | 生产默认：`HOST=127.0.0.1`；若需跨机由反代暴露并限制防火墙 | P0 | `.env.example` / deployment 文档写死推荐值 |
| S2 | 非开发环境 **强制 `ADMIN_TOKEN`**（未设置则 reload/stats 拒绝并打日志） | P0 | 未配 token 时 curl reload → 401 |
| S3 | 错误响应：`{ error: code, message: "服务内部错误", requestId }`；详细只进日志 | P0 | 人为触发 LLM 失败时 body 无堆栈/路径 |
| S4 | CORS 白名单：`CORS_ORIGINS=http://localhost:5173,...` | P1 | 非白名单 Origin 拒绝 |
| S5 | 可选 `X-Device-Id` / 设备密钥中间件，写入 JSONL | P2 | 日志含 deviceId |
| S6 | 部署层：内网 HTTPS（Caddy/nginx）、仅展厅 VLAN、禁外访管理端口 | P1 | `docs/deployment.md` 更新清单 |

### 相关文件

- `server/src/http/cache.ts`（`adminOk`）、`routes/knowledge.ts`、`routes/chat.ts`
- `server/src/index.ts`（cors、listen）
- `docs/deployment.md`

---

## 4. 产品与对接层

### 缺点

1. 前端 **未接 SSE**，仍等完整 `/api/chat` JSON。  
2. 虚拟形象只随本地 TTS，**不感知后端事件**。  
3. 展览播放 → **`GET /api/suggestions?zone=` 未闭环**。  
4. 无知识 **审核/版本/回滚**，只能改文件。  
5. **feedback** 只落盘，无报表、无规则回流。

### 优化建议

| ID | 建议 | 优先级 | 验收 |
|----|------|--------|------|
| P1 | 前端 `sendChat` 改为读 SSE：delta 流式渲染气泡；done 后 TTS 朗读全文 | P0 | 浏览器可看到逐段出现；断线回退到 POST chat |
| P2 | 展览系统：切换媒体时调用 `?zone=<mediaId\|zoneId>`，刷新推荐 chips | P1 | 手动 curl zone 切换推荐；前端可支持动态 zone |
| P3 | `/api/admin/feedback-stats` 或 stats 内 top 负反馈问题列表；导出 CSV | P2 | 能列出 down 率高问题 |
| P4 | 知识：`knowledge/_meta/versions.json` 或 git 工作流 + reload；文档写清发布步骤 | P2 | 变更有记录可回滚 |
| P5 | 形象：授权 `web/public/models/hostess.vrm` 接入（前端已有加载骨架） | P2 | 放模型后 Three.js/后续方案自动加载（注意：前端已回退 CSS 占位，需评估是否再上 3D） |

### 相关文件

- `web/src/api/client.ts`、`web/src/App.tsx`
- `knowledge/_meta/zones.json`、`server/src/knowledge/suggestions.ts`
- `server/src/analytics/stats.ts`、`server/data/events.jsonl`
- `web/src/components/Live2DStage.tsx`

---

## 5. 代码级缺陷清单

| ID | 缺陷 | 优化 | 优先级 |
|----|------|------|--------|
| K1 | 同 `sessionId` 并发 `append` 无锁 | 会话队列/Mutex 或单线程 event 序列化 | P1 |
| K2 | chat 与 SSE 逻辑重复 | 抽 `runChat`（见 E1） | P0 |
| L3 | Cache key 不含知识版本 | key 附加 `retriever.stats().vector.fingerprint` 或 generation；reload 已 clear 作双保险 | P1 |
| K4 | `openapi.json` 无 schema | 补 JSON Schema 或用 zod 导出 | P2 |
| K5 | 单测未覆盖 RRF/向量指纹/SSE/TTL/限流边界 | 扩 `server/scripts/unit.test.ts` | P1 |
| K6 | Mock 与真 LLM 行为差异 | 文档标明；评测集同时跑 mock/真实可选 | P2 |
| K7 | `rateLimit` 超限淘汰非 LRU | 展厅可接受；需要时改时间戳 Map | P3 |

---

## 6. 建议执行顺序（给新会话）

### Phase A — 可上线加固（先做）

1. S1 + S2 + S3（监听地址、ADMIN_TOKEN 强制、错误脱敏）  
2. E1 抽 `runChat` + E4 优雅退出  
3. E2 reload/检索 generation 锁  
4. E3 日志脱敏与轮转  
5. P1 前端接 SSE  
6. 回归：`build` + `unit` + `api-audit`

### Phase B — 回答质量

1. C1 + C2 接入内网 Embedding + LLM（改 `.env`，不改业务 API）  
2. C3 检索评测集与 baseline  
3. C4 同义词/规则迭代 + K3 cache key 带版本  
4. 再跑评测，更新 `docs/eval.md`

### Phase C — 展览闭环与运营

1. P2 展览 zone 联动  
2. P3 反馈统计  
3. C5 PDF 入库（按需）  
4. C6 指代改写（按需）  
5. E6 向量存储升级（知识规模上来后）

---

## 7. 验收命令（每阶段结束必跑）

```bash
npm run build -w server
npm run build -w web
npm test -w server
# 另开终端
npm run dev:server
node server/scripts/api-audit.mjs
```

目标：单元 **全绿**；API 审计 **20/20**（或更新脚本后的全绿）。

---

## 8. 非目标 / 已拒绝

- **不用真人照片/明星肖像**（含「类似范冰冰」）做虚拟人复刻。  
- 未授权 VRM/Live2D 商业模型不入库。  
- 公网无鉴权暴露展厅 API 不做。

---

## 9. 交接注意

1. 新会话先 `npm install`，确认 `node` 可用（本机曾用 `D:\Node.js\node.exe`）。  
2. PowerShell 对中文 JSON 请求易乱码，联调用 **Node fetch** 或浏览器。  
3. monorepo 依赖在根 `node_modules`；后台起服务用根路径下的 `tsx`/`vite`。  
4. 完成任一 Phase 后更新 `CHANGELOG.md` 与相关 `docs/*.md`，并跑第 7 节命令。  
5. 更细历史决策见 `docs/code-audit.md`、`docs/code-review.md`、`docs/compose/spec/`。

---

## 10. 任务勾选（实现时勾掉）

### Phase A

- [x] S1 默认监听 127.0.0.1 + 文档  
- [x] S2 非开发强制 ADMIN_TOKEN  
- [x] S3 错误响应脱敏 + requestId  
- [x] E1 抽 runChat（chat + stream 共用）  
- [x] E4 SIGTERM 优雅退出  
- [x] E2 retriever generation/原子 replace  
- [x] E3 日志脱敏 + 轮转  
- [x] P1 前端 SSE 流式  
- [x] 全量回归测试  

### Phase B

- [x] C1 openai_compat embeddings（代码就绪；本机无内网 `.env`，见 `docs/eval.md` 接入步骤）  
- [x] C2 openai_compat LLM（同上，Mock 离线兜底）  
- [x] C3 retrieval eval 集 + 脚本 + baseline（`npm run eval:retrieval`；bag top1 0.90 / top3 1.00）  
- [x] C4 synonyms/检索迭代  
- [x] K3 cache key 含索引版本（generation）  
- [x] 评测报告落盘（`docs/eval.md` + `docs/eval/baseline.json`）  

### Phase C

- [x] P2 展览 zone 联动（`?zone=` + `window.znwdSetZone` / `znwd:zone`）  
- [x] P3 feedback 统计接口/导出（`/api/admin/feedback-stats`，`?format=csv`）  
- [x] C5/C6/E6 按需 — **本机暂不做**：无 PDF 样本/指代评测需求/知识规模仍 8 chunks；接口与索引已可扩展  
- [x] 文档与 CHANGELOG 终稿  

---

## 11. 第二轮加固（2026-09-18，0.9.0）

> §0–§10 描述的是 0.8.0 状态；本轮由外部评审（Hermes）实测后重写了一批实现，细节见 `CHANGELOG.md` 的 0.9.0 与 `docs/code-audit.md` 第二轮基线。

### 本轮状态（新会话从这里读）

| 项 | 现状 |
|----|------|
| 知识 | 8 个 md → **23 chunks**（标题感知分块） |
| 检索 | 关键词 bigram + **IDF**（单字不再给分）+ 可选语义向量 RRF |
| 闸门 | `MIN_RELEVANCE_SCORE`（当前 3.8，`npm run calibrate -w server` 标定）；未达标答「资料中没有」 |
| 上报 | `retrieval`/`health.retrieval.mode` 如实（bag → `keyword`，附 `degradedReason`） |
| CORS | 默认仅本机开发源；生产用 `CORS_ORIGINS`；SSE 同策略 |
| SSE | `x-accel-buffering: no` + 15s 心跳 + 断开即停 + 与非流式共用答案缓存 |
| 反馈 | 前端「有帮助/没帮助」已接；`/api/stats` 有 `noHit` 计数 |
| 测试 | unit 32/32、api-audit 34/34、eval top1 0.9667 / top3 1.00 / 闸门漏答 0 |

### 本轮完成项

- [x] 入参边界（非字符串 → 400，统一 `http/request.ts`）  
- [x] CORS 白名单（HTTP + SSE 同一策略）  
- [x] 统一 404/405 信封  
- [x] 相关性闸门 + 无命中 system 指令 + `noHit` 贯穿接口/统计  
- [x] 关键词打分改 bigram-only + IDF（评测 top1 0.90 → 0.9667）  
- [x] `retrieval`/`mode` 如实上报 + `semantic`/`degradedReason`/`thresholds`  
- [x] SSE 反代友好 + 缓存一致性 + 断线停止  
- [x] 标题感知分块（长文档可用）+ 单测覆盖切分与重叠  
- [x] 前端反馈闭环、来源提前渲染、未覆盖时展开推荐问法、发送中仍可输入  
- [x] `server/scripts/calibrate.ts` 阈值标定脚本（知识变更后必跑）  
- [x] api-audit 去绝对路径 + 11 项新检查；文档与 CHANGELOG 对齐代码  

### 仍未做（按优先级）

1. **接真实 LLM/Embedding**（C1/C2）：需要内网网关地址与 key；接完必须重跑 `calibrate` + `eval:retrieval`。  
2. **知识本体仍薄**：8 篇 md，域外样本之外的行业问法大概率落入 `noHit`；用 `/api/stats` 的 `noHit` 计数驱动补资料。  
3. **PDF/Word 入库**（C5）：loader 目前只吃 md/txt。  
4. **指代消解**（C6）：多轮「那检测呢？」仍靠 history 直塞 prompt。  
5. **会话/统计持久化**：内存态，重启即清（展厅 120s 闲置自动复位，暂不影响体验）。  
6. **虚拟形象**：仍是程序化占位；用授权模型替换 `Live2DStage.tsx`。  
7. **CI**：目前靠人工跑三条命令；建议加 GitHub Actions（build + unit + api-audit 起停）。  
8. **右侧 2/3 展览播放**：仍为空区，只有 zone 联动接口预留。

---

## 12. 第三轮：补齐上表可本机完成项（2026-09-19，0.10.0）

> 上表 3/4/5/7 已在本轮完成；1/2/6/8 需要外部输入（网关凭据、知识正文、授权形象模型、展项媒体）。

| 项 | 现状 |
|----|------|
| 多轮指代 | `rag/rewrite.ts`：省略式追问继承上一轮主题词；追问 top1 0.6667 → 1.00 |
| 资料入库 | `scripts/ingest-docs.ts`：PDF(pdftotext)/DOCX(python-docx)/txt/md → knowledge/；扫描件明确报错 |
| 持久化 | `state/persist.ts` + `PERSIST_STATE=true`：会话/计数/反馈/未覆盖清单落盘，重启恢复（已实测硬杀重启） |
| 补资料靶子 | `GET /api/admin/uncovered`（noHit 原始提问，限量明文）；`/api/stats` 增 `rewritten`/`uncoveredCount` |
| 一键验收 | `npm run verify`（build→unit→起 dist 服务→api-audit→eval，端口 8791）；CI：`.github/workflows/ci.yml` |
| 测试 | unit 35/35、api-audit 36/36、verify 5/5、eval top1 0.9667 / 闸门漏答 0 |

仍未做：

1. **接真实 LLM/Embedding**：需要内网网关地址与 key（代码已就绪）。  
2. **知识正文**：只有你们能给；入库工具已就绪，`noHit` 清单指哪补哪。  
3. **虚拟形象**：需要授权的 Live2D/VRM 模型。  
4. **右侧 2/3 展览播放**：需要展项媒体清单（视频/图片 URL 或文件），且界面效果本机无法可视化验证（浏览器工具拒绝访问 localhost），需在现场或你们那边确认。  
5. **`.doc` 旧格式 / 扫描件 OCR**：前者需另存 docx，后者需装 OCR（marker-pdf ~5GB）或人工转写。
