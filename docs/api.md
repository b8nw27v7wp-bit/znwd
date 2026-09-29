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
| CORS | 配了 `CORS_ORIGINS` 就按白名单（逗号分隔，可含 `*`）；**没配时只放行** `http(s)://localhost|127.0.0.1|[::1]|0.0.0.0`（任意端口）。未命中的 Origin 不回 `access-control-allow-origin`。响应带 `vary: Origin`，预检缓存 600s，允许方法 `GET,POST,PUT,DELETE,OPTIONS`，允许头 `content-type,authorization` |
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
| 401 | `unauthorized` | 管理接口口令不对；或未配 `ADMIN_TOKEN` 且 `REQUIRE_ADMIN_TOKEN` 仍为默认 `true` |
| 404 | `not_found` | 路由不存在（「接口不存在」）、会话不存在或已过期 |
| 413 | `payload_too_large` | 请求体超限（`/api/speech/*` 为 2MB，其余 64KB）；或写请求没有 `Content-Length`（无法判定大小，一律按超限处理） |
| 429 | `rate_limited` | 超出 `CHAT_RATE_PER_MIN`，额外带 `retryAfterSec` |
| 500 | `internal_error` | 未预期异常；对外固定「服务内部错误」 |
| 502 | `speech_failed` | 语音上游（MiMo）报错或超时：前端应当降级到浏览器内置播报，别把它当网络抖动重试 |
| 503 | `speech_unavailable` | 语音未启用（`AUDIO_PROVIDER=none`）或拿不到 base-url |

### 鉴权（管理接口）

`AdminGuard` 当前规则：

- 配了 `ADMIN_TOKEN` → 必须带 `Authorization: Bearer <token>`；比对走 `MessageDigest.isEqual` 常量时间比较（不是 `String.equals`，避免逐字节试探口令）。
- 没配 → **默认拒绝**（`REQUIRE_ADMIN_TOKEN=true`）；只有显式设为 `false` 且请求来自回环地址时才放行。回环判断使用连接对端 `remoteAddr`，不使用服务接收连接的 `localAddr`，因此同机反向代理不会绕过默认鉴权。

需要鉴权：`GET /api/stats`、`POST /api/knowledge/reload`、`GET /api/admin/*`、`PUT /api/admin/synonyms`。

### 限流

按客户端 IP 的**滑动窗口**计数，默认 30 次/分钟（`CHAT_RATE_PER_MIN`），作用于两个 chat 接口与 `POST /api/speech/recognize`——一次语音提问就是一次提问，不该绕开配额。默认使用连接对端 `remoteAddr`；仅 `TRUST_FORWARDED_FOR=true` 时才取 `x-forwarded-for` 的第一个地址。

`POST /api/speech/synthesize` 单独计数，默认 60 次/分钟（`AUDIO_SYNTH_RATE_PER_MIN`）：一次回答要按句合成多段，跟 chat 共用配额会被一条长回答吃光。

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
| `retrieval` | string | `hybrid`（语义向量参与了本次排序）或 `keyword`（本次没用向量路），如实上报——`keyword` 不是降级 |
| `noHit` | boolean | `true` = 相关性闸门未通过（知识库未覆盖） |
| `sessionId` | string | 回显（未传则不出现） |
| `sessionToken` | string | 会话访问令牌，证明「这个会话是自己的」；`GET/DELETE /api/sessions/{id}` 必须带回来，不匹配按不存在回 404。未传 `sessionId`（没建过会话）时不出现 |
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
| `vectorScore` / `keywordScore` | number | 两路原始分。语义向量只在兜底路径参与排序，所以普通查询的 `vectorScore` 是 0（= 这次排序没用到向量路），`keywordScore` 才是决定排序的那个数 |

**按资料文件去重**：同一份资料的多个命中片段只保留最高分的那条，所以 `sources.length` 是「引了几份资料」，
不是「命中几块」。不去重时来源面板会挂出多张同名卡片、前端 `:key` 也会撞（见 `RagPipeline.toSources`）。

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
data: {"latencyMs":12345,"answer":"…完整回答…","sources":[…],"mode":"rag","provider":"mimo-v2.5","noHit":false,"retrieval":"keyword","cached":false,"rewrite":{"rewritten":false,"reason":"none","carriedTokens":[]},"usage":{"promptTokens":1466,"completionTokens":250,"totalTokens":1716}}
```

| 帧 | data 字段 |
| --- | --- |
| `meta` | `mode`、`sources`、`provider`、`noHit`、`retrieval`、`rewrite{rewritten,reason,carriedTokens}`、`sessionId` |
| `delta` | `text`（增量片段，逐字推送） |
| `done` | `latencyMs`、`answer`（完整文本，便于前端校对）、`sources`、`mode`、`provider`、`noHit`、`retrieval`、`cached`、`rewrite{…}`、`usage?`、`sessionToken?`（会话访问令牌，见下节） |
| `error` | `error`、`message`、`requestId`（与错误信封同形） |

> `done` 是 `meta` 的**超集**，前端收到 done 会覆盖 meta 里的同名字段。所以凡是 meta 给过、
> 前端还要继续读的字段，done 必须重复带上——`rewrite` 就踩过这个坑：它原先只在 meta 里，
> 结果「已按上下文补全提问」的标记在流式结束那一刻被覆盖成 `undefined` 而消失。
> 加字段时按这条对齐：**要么两帧都给，要么前端别在 done 之后读它**。

其它行为：

- **心跳**：每 15 秒发一个 `:ping` 注释帧，避免模型思考期被中间设备判为僵死（注释帧不是事件，前端解析器忽略）。
- **反代**：显式设 `cache-control: no-cache, no-transform`、`x-accel-buffering: no`——nginx/Caddy 不关缓冲就看不到逐字效果。
- **超时**：`LLM_STREAM_TIMEOUT_MS`（默认 180s）+ 30s。
- **客户端断开**（关浏览器/切屏）按正常收尾处理，不打错误日志。
- 拒答时同样先发 `meta`（`noHit=true`），再把固定文案作为 `delta` 推完。
- 前端用 `fetch` + 流式读取（不是 `EventSource`：它只能 GET，而提问要放在 body）；跨 chunk 的半帧会缓存重组；**中途失败不会抹掉已收到的半句**。
- 与非流式共用答案缓存：流式问过的单轮问题，再走 `POST /api/chat` 会 `cached: true`。

## 语音（TTS / ASR）

展厅的「会说话」与「能听懂」都走服务端（小米 MiMo，与对话同网关、同 key）：**key 不进前端**，音色与模型集中在服务端配置。`MimoSpeechModel` 是后端语音出网白名单中的第三个适配器（另两个是 LLM 与 embedding）；`AUDIO_PROVIDER=none` 默认不触发语音外呼。两个接口都是纯增量；未启用时返回 503，TTS 前端当场退回浏览器内置播报，展板不会哑掉。

未启用（`AUDIO_PROVIDER=none`，默认）时：

```json
{ "error": "speech_unavailable", "message": "语音未启用（服务端 AUDIO_PROVIDER=none）", "requestId": "…" }
```

### POST /api/speech/synthesize — 文本转语音

```json
{ "text": "光伏清洁机器人采用无水清扫方案。" }
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `text` | string | 是 | 单句文本。空白、非字符串、超过 `AUDIO_MAX_CHARS`（默认 300 字）都是 400——**前端按句切片后再请求**，别把整篇回答塞进来（一次合成的时间随文本线性增长） |

成功：`200` + `content-type: audio/wav`，body 即 WAV 字节（24kHz/单声道/16bit，可直接塞进 `<audio>`）。响应头 `x-znwd-speech: live|cache` 说明这段是现合成的还是命中服务端缓存（同文本 + 同音色才算命中，缓存条数 `AUDIO_TTS_CACHE_SIZE`）。

失败：`502 speech_failed`（上游报错/超时）、`503 speech_unavailable`。

### POST /api/speech/recognize — 语音转文本

```json
{ "audio": "data:audio/wav;base64,UklGRiQAAABXQVZFZm10…" }
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `audio` | string | 是 | `data:audio/wav;base64,…` 或裸 base64。**只收 WAV（16bit PCM）**：MiMo 只认 wav/mp3，而前端自己采 PCM 拼的就是 wav，放别的格式进来只会让「录到的格式与接口要的格式不一致」晚到运行时才暴露 |

成功：

```json
{ "text": "叶片检测要停机吗", "seconds": 3.2, "elapsedMs": 1070 }
```

`seconds` 是音频时长，用来区分「说了话」与「录到一片静音」。

失败：`400 validation_error`（缺 `audio`／不是合法 base64／不是 WAV／超过 `AUDIO_MAX_UPLOAD_BYTES`）、`413 payload_too_large`（请求体超过 2MB 硬上限）、`502`/`503` 同上。

体积口径：16kHz/单声道/16bit ≈ 32KB/s，base64 后膨胀 4/3。前端录音上限 20 秒（约 640KB 原始、853KB base64），离 2MB 硬上限有一倍余量。

## 会话与反馈

### 会话访问令牌（`X-Session-Token`）

会话归属由**问答时下发的令牌**证明，不再「知道 `sessionId` 就能读/删」：

- 下发：`POST /api/chat` 响应字段 `sessionToken`；`POST /api/chat/stream` 挂在 `done` 帧上（`meta` 帧不带）。
- 带回：`GET`/`DELETE /api/sessions/{id}` 用 `X-Session-Token` 头（或 `?sessionToken=` 查询串，便于手测）。
- 判据：**不匹配一律 404 `not_found`**——不回 403，403 等于承认这个 `sessionId` 有效。
- 兼容：从未下发过令牌的老会话（例如上一版本前端起的会话）仍可不带令牌访问。
  **重启后从 MySQL 恢复的会话也属于这一类**（令牌只存在内存里，不落库），所以它们在这台机器重启后的
  **≤ 会话 TTL（10 分钟）**窗口内是可读可删的；超过 TTL 的会话不会被恢复，库里的行也会被清掉。
  这是单屏展厅设计下的已接受风险，见 `docs/security-testing.md`。
- 前端：令牌只放内存与 `sessionStorage`，不进 URL、不进日志；换人时带令牌 `DELETE` 即可清上下文。

### GET /api/sessions/{sessionId}

请求头带 `X-Session-Token`（或 `?sessionToken=`）。响应：

`{ "sessionId": "demo-1", "messages": [ {"role":"user","content":"…"}, {"role":"assistant","content":"…"} ], "lastActive": 1757000000000 }`

只读、不刷新 TTL；**不存在、已过期或令牌不匹配** → 404 `not_found`。

### DELETE /api/sessions/{sessionId}

同样要求令牌匹配。`{ "ok": true, "sessionId": "demo-1" }`（`ok=false` 表示本来没有这个会话，不算错误）。大屏前换人时清上下文；前端另有「闲置 3 分钟自动回到欢迎态」。

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
  "zones": [ { "id": "pv-doctor", "dir": "02_光伏医生运维系统", "title": "光伏医生智慧运维", "aliases": ["…"], "suggestions": ["…"] } ],
  "media": [ { "mediaId": "exhibit-pv-clean", "title": "光伏清洁机器人展项", "zoneId": "pv-clean" } ]
}
```

## 运行状态与统计

### GET /api/health（无鉴权）

| 字段 | 说明 |
| --- | --- |
| `ok` / `ready` | 两者当前都表示知识快照已加载且索引就绪；启动加载完成前均为 `false`。接口本身仍回 HTTP 200，探活脚本应读取 JSON 字段 |
| `version` | 后端版本（当前 `1.3.0`） |
| `knowledgeChunks` | 已加载知识块数 |
| `llmProvider` | LLM 提供方 |
| `speech` / `speechReady` | 语音 provider（`none`\|`mimo`）/ **服务端语音是否已启用**。`mimo` 且有 base URL 时为 true，但不代表上游此刻一定可达；`false` 时前端播报走浏览器内置合成 |
| `retrieval` | 检索统计对象，见下 |
| `knowledgeDir` / `dataDir` | 实际生效目录（排查「路径错位」先看这里） |
| `activeSessions` / `answerCacheSize` | 活跃会话数 / 答案缓存条目数 |
| `watchKnowledge` | 是否开知识目录热监听 |
| `adminTokenRequired` | 未配置口令时本次请求是否仍要求提供口令；按 `REQUIRE_ADMIN_TOKEN` 与连接对端 `remoteAddr` 判断，默认配置恒为 `true` |
| `corsOrigins` | 生效的 CORS 白名单 |
| `minRelevanceScore` / `noHitLlm` | 当前闸门阈值 / 拒答是否走模型 |
| `embedding` / `embeddingReady` | embedding provider 名（`bag`\|`openai_compat`）/ **语义路当下是否可用**。`openai_compat` 但 `embeddingReady=false` = 语义路挂了（原因在 `retrieval.degradedReason` 或 `retrieval.vector.lastQueryError`），检索已退回仅关键词 |
| `storage` | 固定 `mysql` |
| `storageAvailable` | **库是否可用**；`false` 时服务照常讲解、只是不落库（前端不在页面上提示，只在运营视图的「本机设置」里显示） |
| `host` / `uptimeSec` | 监听地址 / 运行秒数 |

`retrieval`（`HybridStats`）：

```json
{
  "mode": "keyword", "keywordChunks": 219, "indexReady": true, "generation": 1, "semantic": true,
  "vector": {
    "provider": "openai_compat", "semantic": true, "dims": 1024, "vectors": 219,
    "fingerprint": "…", "indexFile": "…",
    "degradedReason": null, "queryFailures": 0, "lastQueryError": null
  },
  "degradedReason": null,
  "thresholds": { "minKeywordScore": 6.3, "minVectorScore": 0.75 }
}
```

- `semantic` 是**当下是否可用**（provider 支持语义 + 索引就绪 + 没在降级 + 查询期没在失败），不是「provider 是否具备语义能力」；
- `mode` 只有在语义向量**真的参与了这次排序**（关键词没过闸门、靠余弦救回）时才是 `hybrid`；关键词路自己过了闸门就是 `keyword`——这是如实上报，不是降级；兜底路径上语义命中可以是**新增候选**（已决策：文档对齐代码，见 `docs/architecture.md` §3），但带闸门的调用要余弦 ≥ `minVectorScore` 才放行，当前 `0.75` 等效关闭，所以线上正常都是 `keyword`；
- `minVectorScore` 默认 `0.75`；当前域外最高余弦 0.6252 高于待救在域用例（0 条、余弦 0.0000），因此这个默认值等价于关闭语义兜底，误拦应通过补语料/同义词解决；
- `vector.degradedReason` 是构建/加载层面的不可用原因；`queryFailures` / `lastQueryError` 记查询期失败（外部服务中途不通），失败会让 `semantic=false`，下一次成功自动自愈。

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
| `keywordBestScore` / `vectorBestCosine` | 两路最高分（原始分，未过闸门）。`keywordBestScore` 就是闸门实际比较的那个数 |
| `keywordGateScore` | 只由用户原话词条贡献的分（不含同义词扩展）。比 `keywordBestScore` 低得多 = 这次是同义词扩展把候选抬上来的 |
| `candidates` | 候选条数 |
| `thresholds` | `{ minKeywordScore, minVectorScore }` |
| `distanceToGate` | **>0 表示还差多少分才够阈值**（负数=已超出） |
| `verdict` | 一句人话结论 |
| `hits[]` | `title`、`sourcePath`、`zone`、`zoneTitle`、`fuseScore`、`keywordScore`、`vectorScore`、`matchedTokens`、`matched[]`、`snippet`。**`vectorScore` 只在语义向量参与了本次排序（兜底路径）时才有值**，其余情况是 0——它不是「这块没有余弦」，而是「这次排序没用到向量路」 |

实测样例（当前 219 块语料、阈值 6.3 / 0.75，语义路已接上）：

```json
// GET /api/admin/diagnostics?q=有客户了吗   （被闸门误拦的真实问句，余弦 0.6389 不够兜底阈值）
{
  "gated": true, "mode": "keyword", "reason": "below_threshold", "semantic": true, "degraded": false,
  "keywordGateScore": 4.9037, "keywordBestScore": 4.9037, "vectorBestCosine": 0.6389, "candidates": 16,
  "thresholds": { "minKeywordScore": 6.3, "minVectorScore": 0.75 },
  "distanceToGate": 1.3963, "hits": []
}

// GET /api/admin/diagnostics?q=帮我写一首关于夏天的诗   （域外）
{
  "gated": true, "mode": "keyword", "reason": "below_threshold", "semantic": true, "degraded": false,
  "keywordGateScore": 0.0, "keywordBestScore": 0.0, "vectorBestCosine": 0.2083, "candidates": 8,
  "thresholds": { "minKeywordScore": 6.3, "minVectorScore": 0.75 },
  "distanceToGate": 6.3, "hits": []
}
```

在域问题应看到 `gated=false`、`verdict` 里带余量（例：「清洁作业流程是怎样的？」→ `01_光伏清洁机器人/清洁作业流程.md`，关键词 32.89 / 余量 26.59，其中只算用户原话的分 31.58——差值是同义词扩展补上来的）。

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

### GET /api/knowledge/list（需鉴权）

带 `authorization: Bearer <ADMIN_TOKEN>`；不带（或口令不对）返回 401。它会吐出 `knowledgeDir` 与索引文件的绝对路径、全部文档清单，历史上漏过守卫，现已过 `AdminGuard`（见 `docs/security.md`）。

```json
{
  "knowledgeDir": "E:\\znwd\\knowledge",
  "fileCount": 17, "chunkCount": 219,
  "retrieval": { "…同 /api/health 的 retrieval…": "" },
  "zones": ["…"],
  "synonyms": { "count": 23, "source": "builtin", "file": "…synonyms.tsv" },
  "docs": [ { "path": "01_光伏清洁机器人/产品概述.md", "title": "两栖光伏清洁机器人产品概述", "zone": "pv-clean", "zoneTitle": "光伏清洁机器人", "chunks": 11 } ]
}
```

### POST /api/knowledge/reload（需鉴权）

重载知识、重建关键词与向量索引，并清空答案缓存。

`{ "ok": true, "knowledgeChunks": 219, "generation": 2, "retrieval": {…}, "synonyms": {…}, "files": [ {"sourcePath":"…","chunks":5} ] }`

### GET /api/openapi.json（无鉴权）

返回 `server/src/main/resources/openapi.json` 的内容（版本 `1.3.0`，含 `ChatRequest`/`ChatResponse`/`Source`/`Error`/`Diagnostics`/`Synonyms` schema）。契约改动改这个文件，别在 Java 里手拼 JSON。

## 契约冻结

- 路径、响应字段名、SSE 事件序列（`meta`→`delta`→`done`）与 `noHit`/`sources` 语义**必须与重构前的 Node 版一致**：前端、评测脚本、一体机部署脚本都按这套写，悄悄改字段比服务起不来更难查。
- 唯一已知差异（刻意的修正）：`/api/suggestions` 的 `items` 是**字符串数组**；前端曾按对象取 `question`，那会让大屏出现空白推荐按钮，现已在 `web/src/api.ts` 按字符串对齐。
- 新增能力（`/api/admin/diagnostics`、`/api/admin/synonyms`、`/api/health/summary`、`/api/knowledge/list` 的 `synonyms` 字段、`/api/speech/*` 两个语音接口与 `health.speech`/`health.speechReady`）均为纯增量，不动老字段。
- 改完接口跑 `python tools/smoke.py`（契约检查：语音未启用 60 项，启用时 63 项，均需带 `ADMIN_TOKEN` 才跑满管理块——`/api/knowledge/list` 与 `/api/admin/*` 一样要口令。语音段按 `speechReady` 分别校验「真出 WAV」与「503 可判定」两条路径）。
- 改检索后跑 `exec:java@eval --no-write --baseline=docs/eval/baseline-java.json`；CI 用同一基线逐例守住 top1 路径、top1/top3、闸门指标与漏答数，另以 `calibrate --gate-check` 守域外不越线。

## curl 示例

```bash
# 语音：合成一段 WAV（未启用时是 503 speech_unavailable；-D - 看 x-znwd-speech 判断 live/cache）
curl -s -X POST http://127.0.0.1:8787/api/speech/synthesize \
  -H "content-type: application/json" \
  -d '{"text":"欢迎参观光伏清洁机器人展区。"}' -o tts.wav -D -

# 把刚合成的音频喂回识别（Python 发更省事：二进制 base64 在 GBK 控制台里容易编坏）
python -c "import base64,json,urllib.request as u; w=open('tts.wav','rb').read(); r=u.Request('http://127.0.0.1:8787/api/speech/recognize',data=json.dumps({'audio':'data:audio/wav;base64,'+base64.b64encode(w).decode()}).encode(),headers={'content-type':'application/json'}); print(json.load(u.urlopen(r)))"

curl -s http://127.0.0.1:8787/api/health
curl -s -H "authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/api/knowledge/list

curl -s -X POST http://127.0.0.1:8787/api/chat \
  -H "content-type: application/json" \
  -d '{"message":"叶片检测要停机吗？","sessionId":"demo"}'

# 中文 query 建议用 Python 发（GBK 控制台会把 curl 的 --data-urlencode 编坏）：
python -c "import json,urllib.parse,urllib.request as u; q=urllib.parse.quote('叶片检测要停机吗？'); print(json.load(u.urlopen('http://127.0.0.1:8787/api/admin/diagnostics?q='+q))['verdict'])"

curl -s -X POST http://127.0.0.1:8787/api/knowledge/reload -H "authorization: Bearer $ADMIN_TOKEN"
```
