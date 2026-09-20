# HTTP API 契约

后端：Spring Boot 3.5.16（`server/`），默认监听 `http://127.0.0.1:8787`（`HOST`/`PORT` 可改）。
前端 dev（`:5173`）由 Vite 把 `/api` 代理到 `8787`；展厅部署时把 `web/dist` 交给任意静态服务器，跨域靠 `CORS_ORIGINS` 白名单。

契约基线：**路径与响应字段与重构前的 Node 版保持一致**，前端、脚本、评测可直接复用；新增能力全部是纯增量（见文末「契约冻结」）。

## 通用约定

| 项 | 约定 |
| --- | --- |
| 编码 | UTF-8；`content-type: application/json` |
| 空值 | Jackson 配了 `default-property-inclusion: non_null`——**值为 null 的字段不出现在响应里**，前端取字段要按可选处理 |
| 请求 ID | 每个响应带 `x-request-id` 头（8 位），出错时同一值出现在错误信封里，便于对日志 |
| CORS | 配了 `CORS_ORIGINS` 就按白名单（逗号分隔，可含 `*`）；**没配时只放行** `http(s)://localhost|127.0.0.1|[::1]|0.0.0.0`（任意端口）。未命中的 Origin 不回 `access-control-allow-origin`。响应带 `vary: Origin`，预检缓存 600s，允许方法 `GET,POST,DELETE,OPTIONS`，允许头 `content-type,authorization` |
| 时间 | 毫秒时间戳（`long`），时区 `Asia/Shanghai` |

### 统一错误信封

任何非 2xx 都是同一形状（`GlobalExceptionHandler` 兜底；未预期异常对外只有「服务内部错误」，细节进日志）：

```json
{ "error": "validation_error", "message": "message is required", "requestId": "3f1a9c2d" }
```

| HTTP | `error` | 触发场景 |
| --- | --- | --- |
| 400 | `validation_error` | `message` 缺失/非字符串/空、body 不是 JSON 对象、`rating` 不是 `up`/`down`、诊断接口缺 `q`、同义词表为空 |
| 400 | `validation_error` | 请求体不是合法 JSON（文案固定「请求体不是合法 JSON 对象」，**不会**复用 chat 的文案把排查方向指错） |
| 401 | `unauthorized` | 管理接口口令不对；或生产未配 `ADMIN_TOKEN` |
| 404 | `not_found` | 路由不存在（「接口不存在」）、会话不存在或已过期 |
| 429 | `rate_limited` | 超出 `CHAT_RATE_PER_MIN`，额外带 `retryAfterSec` |
| 500 | `internal_error` | 未预期异常；对外固定「服务内部错误」 |

### 鉴权（管理接口）

`AdminGuard` 规则与旧实现一致：

- 配了 `ADMIN_TOKEN` → 必须带 `Authorization: Bearer <token>`；比对走 `MessageDigest.isEqual` 常量时间比较（不是 `String.equals`，避免逐字节试探口令）。
- 没配 → 开发环境放行；**生产（`NODE_ENV=production|prod|staging` 或 `REQUIRE_ADMIN_TOKEN=true`）直接 401**，不会静默开放。

需要鉴权：`GET /api/stats`、`POST /api/knowledge/reload`、`GET /api/admin/*`、`PUT /api/admin/synonyms`。

### 限流

按客户端 IP 的**滑动窗口**计数，默认 30 次/分钟（`CHAT_RATE_PER_MIN`），只作用于两个 chat 接口。反代场景取 `x-forwarded-for` 的第一个地址。

```json
{ "error": "rate_limited", "message": "too many requests", "retryAfterSec": 12, "requestId": "…" }
```

## POST /api/chat — 问答（非流式）

```json
{ "message": "叶片检测要停机吗？", "sessionId": "demo-1" }
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `message` | string | 是 | 用户提问；>2000 字符按 2000 **截断**（不报错） |
| `sessionId` | string | 否 | 先剔除 `[^A-Za-z0-9._-]` 字符，再截断到 64 字符；结果为空视同未传。同一 ID 保留最近多轮上下文 |

响应 200：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `answer` | string | 回答正文 |
| `sources` | array | 命中资料；未命中为 `[]` |
| `mode` | string | `rag`（有资料）或 `llm_only`（无资料/拒答） |
| `provider` | string | 出词的模型名；**闸门拒答时为 `gate`**（表示没调模型） |
| `retrieval` | string | `hybrid`（语义向量参与融合）或 `keyword`（降级为纯关键词），如实上报 |
| `noHit` | boolean | `true` = 相关性闸门未通过（知识库未覆盖） |
| `sessionId` | string | 回显（未传则不出现） |
| `latencyMs` | number | 端到端耗时 |
| `cached` | boolean | 命中答案缓存（缓存 key 含模型 + 索引 generation + 问题，reload 后不串代） |
| `usage` | object | `{promptTokens, completionTokens, reasoningTokens, totalTokens}`；缓存命中与闸门拒答时没有 |
| `rewrite` | object | `{rewritten, reason, carriedTokens}`；检索用改写后的查询，回答仍按原问题 |

`sources[]` 每项：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title` | string | 块标题 |
| `snippet` | string | 片段 |
| `score` | number | RRF 融合分 |
| `sourcePath` | string | 相对知识库的路径 |
| `zone` / `zoneTitle` | string | 展区 id / 展区名（可为空） |
| `vectorScore` / `keywordScore` | number | 两路原始分（无向量路时 `vectorScore=0`） |

`rewrite.reason`：`none`（未改写）、`no_history`、`prev_weak`（上一轮检索偏弱）、`ellipsis_merged`（省略/追问被合并补全）。

**闸门拒答**：`noHit=true`、`sources=[]`、`provider="gate"`、`mode="llm_only"`，正文为固定文案（`RagPipeline.NO_HIT_REPLY`），**不调用大模型**。要让模型自己组织拒答文案，设 `NO_HIT_LLM=true`。

## POST /api/chat/stream — 问答（SSE）

`content-type: text/event-stream`。帧序列固定 **`meta` → `delta`×N → `done`**，异常时发 `error` 帧后结束。

```text
event:meta
data: {"mode":"rag","sources":[…],"provider":"mimo-v2.5","noHit":false,"retrieval":"keyword","rewrite":{"rewritten":false,"reason":"none","carriedTokens":[]},"sessionId":"demo-1"}

event:delta
data: {"text":"叶片"}

event:done
data: {"latencyMs":12345,"answer":"…完整回答…","sources":[…],"mode":"rag","provider":"mimo-v2.5","noHit":false,"retrieval":"keyword","cached":false,"usage":{"promptTokens":1466,"completionTokens":250,"totalTokens":1716}}
```

| 帧 | data 字段 |
| --- | --- |
| `meta` | `mode`、`sources`、`provider`、`noHit`、`retrieval`、`rewrite{rewritten,reason,carriedTokens}`、`sessionId` |
| `delta` | `text`（增量片段，逐字推送） |
| `done` | `latencyMs`、`answer`（完整文本，便于前端校对）、`sources`、`mode`、`provider`、`noHit`、`retrieval`、`cached`、`usage?` |
| `error` | `error`、`message`、`requestId`（与错误信封同形） |

其它行为：

- **心跳**：每 15 秒发一个 `:ping` 注释帧，避免模型思考期被中间设备判为僵死（注释帧不是事件，前端解析器忽略）。
- **反代**：显式设 `cache-control: no-cache, no-transform`、`x-accel-buffering: no`——nginx/Caddy 不关缓冲就看不到逐字效果。
- **超时**：`LLM_STREAM_TIMEOUT_MS`（默认 180s）+ 30s。
- **客户端断开**（关浏览器/切屏）按正常收尾处理，不打错误日志。
- 拒答时同样先发 `meta`（`noHit=true`），再把固定文案作为 `delta` 推完。
- 前端用 `fetch` + 流式读取（不是 `EventSource`：它只能 GET，而提问要放在 body）；跨 chunk 的半帧会缓存重组；**中途失败不会抹掉已收到的半句**。
- 与非流式共用答案缓存：流式问过的单轮问题，再走 `POST /api/chat` 会 `cached: true`。

## 会话与反馈

### GET /api/sessions/{sessionId}

`{ "sessionId": "demo-1", "messages": [ {"role":"user","content":"…"}, {"role":"assistant","content":"…"} ], "lastActive": 1757000000000 }`

只读、不刷新 TTL；不存在或已过期 → 404 `not_found`。

### DELETE /api/sessions/{sessionId}

`{ "ok": true, "sessionId": "demo-1" }`（`ok=false` 表示本来没有这个会话，不算错误）。大屏前换人时清上下文；前端另有「闲置 3 分钟自动回到欢迎态」。

### POST /api/feedback

```json
{ "rating": "up", "sessionId": "demo-1", "question": "叶片检测要停机吗？", "comment": "讲得清楚" }
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `rating` | 是 | 只接受 `up` / `down`，其它 400 |
| `sessionId` | 否 | 关联会话（同样做字符清洗与截断） |
| `question` | 否 | **不传时自动取该会话最后一条用户提问**（保证运营看到真实问题）；最长 200 字 |
| `comment` | 否 | 最长 500 字 |

响应 `{ "ok": true }`。前端「有帮助 / 没帮助」按钮即调它，失败会回滚本地标记。

## 展区与推荐问题

### GET /api/suggestions?zone=<zoneId 或 mediaId>

```json
{ "items": ["叶片检测要停机吗？", "光伏展区展示什么？"], "zone": "wind-inspect" }
```

**`items` 是字符串数组**（与旧契约一致，前端直接当字符串渲染按钮）。`zone` 可传 `zones.json` 的 `zone.id`，也可传 `media[].mediaId`（旁侧展项播放时用）。不传 zone 返回全馆汇总。

### GET /api/zones

```json
{
  "zones": [ { "id": "wind-inspect", "dir": "02_风场检测无人机", "title": "风场检测", "aliases": ["…"], "suggestions": ["…"] } ],
  "media": [ { "mediaId": "exhibit-pv-clean", "title": "光伏展项", "zoneId": "pv-clean" } ]
}
```

## 运行状态与统计

### GET /api/health（无鉴权）

| 字段 | 说明 |
| --- | --- |
| `ok` / `version` | 存活 / 后端版本（当前 `1.2.0`） |
| `knowledgeChunks` | 已加载知识块数 |
| `llmProvider` / `embedding` | LLM 提供方 / 向量提供方（`bag`\|`openai_compat`） |
| `retrieval` | 检索统计对象，见下 |
| `knowledgeDir` / `dataDir` | 实际生效目录（排查「路径错位」先看这里） |
| `activeSessions` / `answerCacheSize` | 活跃会话数 / 答案缓存条目数 |
| `watchKnowledge` | 是否开知识目录热监听 |
| `adminTokenRequired` | 生产是否强制管理口令 |
| `corsOrigins` | 生效的 CORS 白名单 |
| `minRelevanceScore` / `noHitLlm` | 当前闸门阈值 / 拒答是否走模型 |
| `storage` | 固定 `mysql` |
| `storageAvailable` | **库是否可用**；`false` 时服务照常讲解、只是不落库（前端不在页面上提示，只在运营视图的「本机设置」里显示） |
| `host` / `uptimeSec` | 监听地址 / 运行秒数 |

`retrieval`（`HybridStats`）：

```json
{
  "mode": "keyword", "keywordChunks": 134, "indexReady": true, "generation": 2, "semantic": false,
  "vector": { "provider": "bag", "semantic": false, "dims": 512, "vectors": 134, "fingerprint": "…", "indexFile": "…" },
  "degradedReason": "EMBED_PROVIDER=bag（特征哈希，非语义向量）",
  "thresholds": { "minKeywordScore": 6.3, "minVectorScore": 0.35 }
}
```

### GET /api/health/summary（无鉴权）

给运维快速核对的零敏感摘要：`{ "chatTotal": 12, "noHit": 3, "activeSessions": 1, "retrieval": "keyword" }`。

### GET /api/stats（需鉴权）

`uptimeSec`、`chatTotal`、`ragHits`、`llmOnly`、`noHit`、`rewritten`、`uncoveredCount`、`tokens{prompt,completion,reasoning,total,calls}`、`errors`、`activeSessions`、`feedback{up,down}`、`recent[]`。

- `noHit` = 知识库未覆盖次数（下一批要补的资料就在这儿）；
- `tokens.reasoning > 0` 说明上游思考模式没关（又慢又贵）；
- 会话/统计/反馈现在落 MySQL，**重启不清零**；`recent` 是内存窗口。

### GET /api/admin/uncovered（需鉴权）

`{ "count": 3, "items": [ {"at":…, "sessionId":"…", "question":"…"} ] }`，新→旧；留存条数由 `UNCOVERED_LOG_SIZE` 控制（0 = 关闭）。

### GET /api/admin/feedback-stats（需鉴权）

- 默认 `{ total, up, down, downRate, topDown[], recent[], recentDown[] }`
- `?format=csv` → `text/csv; charset=utf-8`，`content-disposition: attachment; filename="feedback.csv"`

## GET /api/admin/diagnostics?q=…&topK=4（需鉴权）

检索诊断：**为什么被拦、为什么命中、离阈值还差多少**。走线上同一套索引与阈值，结论可直接判案。

| 查询参数 | 必填 | 说明 |
| --- | --- | --- |
| `q` | 是 | 要诊断的问题（缺失 → 400） |
| `topK` | 否 | 命中条数，默认 4，范围 1~20 |

| 字段 | 说明 |
| --- | --- |
| `query` / `topK` | 回显 |
| `gated` | `true` = 被闸门拦下 |
| `mode` | `keyword` / `hybrid` |
| `reason` | `keyword_hit` / `vector_hit` / `no_candidates` / `below_threshold` |
| `semantic` / `degraded` | 语义向量是否可用 / 是否降级 |
| `keywordBestScore` / `vectorBestCosine` | 两路最高分（原始分，未过闸门） |
| `candidates` | 候选条数 |
| `thresholds` | `{ minKeywordScore, minVectorScore }` |
| `distanceToGate` | **>0 表示还差多少分才够阈值**（负数=已超出） |
| `verdict` | 一句人话结论 |
| `hits[]` | `title`、`sourcePath`、`zone`、`zoneTitle`、`fuseScore`、`keywordScore`、`vectorScore`、`matchedTokens`、`matched[]`、`snippet` |

实测样例（当前 134 块语料、阈值 6.3）：

```json
// GET /api/admin/diagnostics?q=帮我写一首关于夏天的诗
{
  "gated": true, "mode": "keyword", "reason": "below_threshold", "semantic": false, "degraded": true,
  "keywordBestScore": 2.218, "vectorBestCosine": 0.0, "candidates": 16,
  "thresholds": { "minKeywordScore": 6.3, "minVectorScore": 0.35 },
  "distanceToGate": 4.082, "hits": [],
  "verdict": "闸门拦下：有候选但相关度不够（关键词最高 2.22 / 阈值 6.30；语义向量不可用（当前为降级模式），只剩关键词路）"
}
```

在域问题应看到 `gated=false`、`verdict` 里带余量（例：「叶片检测要停机吗？」关键词 24.33 / 余量 18.03；「光伏清洁无人机是做什么的？」关键词 22.42）。

> curl 手拼中文 `q` 时注意：GBK 控制台下会编码成乱码，表现为「什么都被拦」。用 Python 的 `urllib.parse.quote`，或直接跑 `python tools/smoke.py`（内部已正确编码）。

## 同义词表

### GET /api/admin/synonyms（需鉴权）

```json
{
  "count": 23,
  "source": "builtin",
  "file": "E:\\znwd\\knowledge\\_meta\\synonyms.tsv",
  "entries": [ { "key": "叶片", "alternatives": ["叶片", "风叶", "桨叶"] } ],
  "tsv": "# 主词\t备选词（逗号分隔）\n叶片\t风叶,桨叶\n"
}
```

`source` = `builtin`（代码内置）或覆盖表文件路径。

### PUT /api/admin/synonyms（需鉴权）

**替换整张表**。两种请求体都收：

```json
{ "lines": ["叶片\t风叶,桨叶", "# 注释行会被忽略"], "persist": true }
```

```json
{ "entries": { "叶片": ["叶片", "风叶", "桨叶"] }, "persist": false }
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `lines` / `entries` | — | 二选一；都空则 400 |
| `persist` | `true` | `true` 写回 `knowledge/_meta/synonyms.tsv`；`false` 只改内存（重启即失） |

响应：`{ "ok": true, "count": 24, "source": "…tsv", "persistedTo": "…tsv", "persistRequested": true, "reloadRequired": false }`

- 同义词在**查询期展开**，改完对下一个问题立即生效，**不需要重建索引**（`reloadRequired` 恒为 `false`）。
- 落盘失败时 `persistedTo` 为 `null`，服务端日志报错（内存已生效，不假装成功）。
- 覆盖表被删掉后，`POST /api/knowledge/reload` 会退回内置表（避免「文件删了还生效」）。

## 知识库

### GET /api/knowledge/list（无鉴权）

```json
{
  "knowledgeDir": "E:\\znwd\\knowledge",
  "fileCount": 8, "chunkCount": 134,
  "retrieval": { "…同 /api/health 的 retrieval…": "" },
  "zones": ["…"],
  "synonyms": { "count": 23, "source": "builtin", "file": "…synonyms.tsv" },
  "docs": [ { "path": "01_光伏清洁无人机/产品概述.md", "title": "光伏清洁无人机", "zone": "pv-clean", "zoneTitle": "光伏清洁", "chunks": 5 } ]
}
```

### POST /api/knowledge/reload（需鉴权）

重载知识、重建关键词与向量索引，并清空答案缓存。

`{ "ok": true, "knowledgeChunks": 134, "generation": 2, "retrieval": {…}, "synonyms": {…}, "files": [ {"sourcePath":"…","chunks":5} ] }`

### GET /api/openapi.json（无鉴权）

返回 `server/src/main/resources/openapi.json` 的内容（版本 `1.2.0`，含 `ChatRequest`/`ChatResponse`/`Source`/`Error`/`Diagnostics`/`Synonyms` schema）。契约改动改这个文件，别在 Java 里手拼 JSON。

## 契约冻结

- 路径、响应字段名、SSE 事件序列（`meta`→`delta`→`done`）与 `noHit`/`sources` 语义**必须与重构前的 Node 版一致**：前端、评测脚本、一体机部署脚本都按这套写，悄悄改字段比服务起不来更难查。
- 唯一已知差异（刻意的修正）：`/api/suggestions` 的 `items` 是**字符串数组**；前端曾按对象取 `question`，那会让大屏出现空白推荐按钮，现已在 `web/src/api.ts` 按字符串对齐。
- 新增能力（`/api/admin/diagnostics`、`/api/admin/synonyms`、`/api/health/summary`、`/api/knowledge/list` 的 `synonyms` 字段）均为纯增量，不动老字段。
- 改完接口跑 `python tools/smoke.py`（56 项契约检查，含上述字段的存在性与类型）。

## curl 示例

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s http://127.0.0.1:8787/api/knowledge/list

curl -s -X POST http://127.0.0.1:8787/api/chat \
  -H "content-type: application/json" \
  -d '{"message":"叶片检测要停机吗？","sessionId":"demo"}'

# 中文 query 建议用 Python 发（GBK 控制台会把 curl 的 --data-urlencode 编坏）：
python -c "import json,urllib.parse,urllib.request as u; q=urllib.parse.quote('叶片检测要停机吗？'); print(json.load(u.urlopen('http://127.0.0.1:8787/api/admin/diagnostics?q='+q))['verdict'])"

curl -s -X POST http://127.0.0.1:8787/api/knowledge/reload -H "authorization: Bearer $ADMIN_TOKEN"
```
