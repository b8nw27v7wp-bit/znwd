# 项目后端优化 Plan（交接文档）

> 生成日期：2026-09-17  
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

- [ ] C1 openai_compat embeddings  
- [ ] C2 openai_compat LLM  
- [ ] C3 retrieval eval 集 + 脚本 + baseline  
- [ ] C4 synonyms/检索迭代  
- [ ] K3 cache key 含索引版本  
- [ ] 评测报告落盘  

### Phase C

- [ ] P2 展览 zone 联动  
- [ ] P3 feedback 统计接口/导出  
- [ ] C5/C6/E6 按需  
- [ ] 文档与 CHANGELOG 终稿  
