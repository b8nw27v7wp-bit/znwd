# 全双工 P1 实施计划（交接稿）

> **状态**：**已实施完毕并归档**（2026-10-12）。计划从基线 commit `c9e1697` 出发，A→F 各段均已落地；
> 唯一未做的是「端点检测升级为前端 VAD + 服务端复核」——本轮范围决策只要滚动识别 + 常开聆听，
> 该项留在 [voice-realtime-plan.md](../voice-realtime-plan.md) 的 P1 状态表里（标 ❌）。
> 场馆声学实测报告仍待现场产出（采集通道已通）。
>
> **用法**：本文是**历史记录**，不是现状。要了解现状请看 `CHANGELOG.md`、[api.md](../api.md)、
> 与 [voice-realtime-plan.md](../voice-realtime-plan.md)（第 3 档路线/分期/验收总纲）。

## 0. 已确认的范围决策（用户拍板，不要重新问）

1. **本轮 = 滚动识别 + 常开聆听**：麦克风常开（本地能量门控，有声才推流）+ 说话过程中分段送识别、文字边说边出，含独立 ASR 限流与运营声学遥测。
2. **常开聆听默认开、运营可关**（存储键缺省 = 开，运营视图 `?admin=1` 里有开关兜底）。
3. **明确不做**：P2 流式 TTS 词级流水线（需换供应商）、P3 插话打断（回声/自打断，规划文档标注的最难项，须等 P1 展厅声学实测报告过闸）。播报期间麦克风**抑制**而非打断。

## 0.1 三个已核实的硬约束（探索结论，实施时直接信任）

- `recognize` 现与 `/api/chat` 共用 `chatRateLimiter` 30/min（`SpeechController.java` L131，注释「识别与提问同配额」）——滚动分段 ≈30 次/分/说话人，会瞬间打满并饿死问答，**必须拆独立限流**。
- `SpeechParser.audio()` 对 1–3 秒合法 WAV 无任何时长限制（`/api/speech/*` 2MB 路径上限内），**分段识别后端解析零改动**；`RequestSizeLimitFilter` 要求 Content-Length（分块一律拒），分段必须是离散 POST——本方案正是。
- 声学数据只有前端能看到（噪声 RMS、VAD 判定），运营面板数据源是 `/api/stats`（`Analytics` 内存计数器模式），需要一条小的上报通道。

---

# 实施计划正文（已批准）

## A. 后端（server）

**A1 限流拆分**
- `config/AppProperties.java` `Audio` record 增加 `asrRatePerMin`、`metricsRatePerMin`（接在 `synthRatePerMin` 后，javadoc 各写清用途）；访问器沿用 `audioSynthRatePerMin()` 的 `<=0 ? 默认值 :` 模式（约 L225 先例；已确认无测试按位置构造 Audio）。
- `resources/application.yml` audio 段（约 L166 后）：`asr-rate-per-min: ${AUDIO_ASR_RATE_PER_MIN:120}`（120 ≈ 每说话人 30 次/分 + 收尾调用 + 突发余量）、`metrics-rate-per-min: ${AUDIO_METRICS_RATE_PER_MIN:30}`（名义 15s 一批 = 4/min，30 给节流恢复留余量）。
- `config/AppConfig.java`：`asrRateLimiter`、`speechMetricsRateLimiter` 两个 bean，复制 `feedbackRateLimiter`（约 L70）写法。
- `web/SpeechController.java`：`recognize()` 的 `@Qualifier("chatRateLimiter")` 换 `asrRateLimiter`；**重写该处注释**（诚实说明：分段识别下一次讲话会连打多次 recognize，与 /api/chat 同桶会互相饿死；识别与提问配额分立，提问仍由 /api/chat 自己的桶把关）；`ChatController` 不动。
- `server/.env.example`：约 L74 注释「识别与问答共用 CHAT_RATE_PER_MIN」**必须同步改**，补两个新 env 注释行（`AUDIO_ASR_RATE_PER_MIN`、`AUDIO_METRICS_RATE_PER_MIN`）。

**A2 遥测端点 `POST /api/speech/metrics`**（加在 SpeechController，继承 `/api/speech/*` 的 2MB 路径封顶，自封顶 ~4KB）
- 请求体：**增量计数**的扁平 JSON（全部可选、有限数值）：`utterances, autoEnds, manualEnds, noSpeechAborts, falseTriggers, segmentCalls, segmentFailures, segmentDropped, suppressedAbandons, noiseFloorSum, noiseSamples, partialLatencySumMs, partialLatencyCount`。
- 校验：未知键/非数值/负数/绝对值 >1e6 → `ApiException.validation`；`limit(speechMetricsRateLimiter, request)`（429 复用现有翻译）；**不挂 `requireEnabled()`**（`AUDIO_PROVIDER=none` 时遥测仍有价值）；成功回 `{ok:true}`。
- 鉴权取舍（已论证）：无鉴权 + 限流 + 尺寸封顶。备选过并否决：admin 口令门会让面板没打开时丢数据；纯前端本地存会随刷新丢失且绕开 `/api/stats` 既有链路。

**A3 Analytics**（`analytics/Analytics.java`）
- `public synchronized void recordSpeech(Map<String, Double> deltas)`：逐键 clamp（负数归 0、封顶 1e6）。
- `stats()`（约 L180 区域）加 `out.put("speech", …)` 嵌套 map（同 `tokens`/`feedback` 先例）：原始计数 + 计算值 `avgNoiseRms`（sum/count）、`avgNoiseDb`（`20*log10`，count=0 → -120 下限）、`avgPartialLatencyMs`。无 schema 变更，沿用「同锁可见性」注释口径（约 L177）。

**A4 安全/契约工具**
- `tools/security.py`：metrics 用例三条（非数值→400、超大→413、第 31 次→429），镜像现有 speech 用例（约 L740+）。
- 核对 `server/src/test` 是否有 controller 端点枚举类测试需补新路由；有 MockMvc 先例就补，没有则限流拆分用 RateLimiter 行为测试 + Analytics 单测覆盖，接口契约交给 smoke/security 工具。

## B. useDictation 重构（`web/src/composables/useDictation.ts`，本轮核心）

纯函数（`vadStep/chunkRms/resample/encodeWav/initialVad`）与现有常量**不动**；新增 `SEGMENT_MS=2000`（≈64KB WAV ≪ 2MB）、`MAX_SEGMENT_INFLIGHT=2`、`SEGMENT_TIMEOUT_MS=15_000`（现有 90s 对分段太松）。

**状态机**（两个维度：`mode: 'tap'|'always'` × 麦克风生命周期）：

```
closed ──start/arm──▶ opening(pending) ──▶ listening        ← always 常态：流+Context 常开
listening ──watch-VAD speechSeen──▶ capturing（每次语句重置 vad/chunks/partialSeq）
capturing ──静音VAD/MAX/手动──▶ recognizing(busy) ──always──▶ listening（不释放）
tap 模式：closed→opening→capturing→recognizing→closed（stop() 入口照旧 release）
ops关/dispose/unmount ──▶ closed（释放轨道与 Context）
```

- `listening` 态：每个 chunk 照跑 watch-VAD + 底噪采样，**不累积 PCM**、`elapsedMs` 冻结。
- 新公开 API：`arm()`（开麦不进语句）、`setAlwaysOn(on)`、`setSuppressed(bool)`；新 ref `armed`；新 option `onPartial?: (text: string|null) => void`、`onMetrics?: (e) => void`。
- `VAD_NO_SPEECH_MS` 超时只在 tap 模式生效（listening 没有「录音开始」概念）；`MAX_RECORD_MS` 两模式都在 capturing 生效。
- **tap 模式语义回归必须保持**：`start/stop/cancel/dispose`、`MIN_RECORD_MS`、错误路径全不动（现有测试全绿为证）。

**抑制（回声；barge-in 不在本轮）**：`setSuppressed(true)` 由 App 在 `chat.streaming || speech.speaking` 时调用——麦克风保持打开（避免权限抖动），但 watch-VAD/底噪/分段全部冻结；若正处 capturing → **放弃本语句**（丢 chunks、bump generation、`onPartial(null)`、不报错，计 `suppressedAbandons`），在途分段请求 abort。理由：TTS 音量会伪造 `speechSeen` 并污染底噪。

**分段管线（仅 always 模式）**：capturing 中累计 `segmentSamples`，达 `SEGMENT_MS`（按 contextRate 折算）→ 切片（不重叠）→ `encodeWav(resample(16k))` → 并发 <2 才 POST（超了 `segmentDropped++`），每语句带 `utteranceId`，过期响应丢弃；成功 → 累计各段文本 → `onPartial(join)`；失败/429 → 静默 + `segmentFailures`。**终稿永远走现有整段识别路径**（`onText` → 自动提问），partial 纯预览不提交。

**遥测钩子**：`noise {rms}`（armed 且非抑制、`rms < VAD_SPEECH_RMS` 时才记）、`end {mode:'auto'|'manual'|'max', ms}`、`falseTrigger`（整段识别回空——always 模式静默计数不走 onError 刷屏；tap 模式保留「没有听清」现有 UX）、`segment {ok, latencyMs}`。

## C. App 接线与 UI（`web/src/App.vue`）

- **首个手势自动开麦**：重构 `unlockSpeechOnce`（约 L69-74）为共享 handler——`speech.unlock()` + 若常开则 `dictation.arm()`；该监听在成功 arm 前**不摘**（现有实现一次性移除，需改为 armed 后再摘）。**arm 门禁**：`chat.bootstrap()` 完成且 `health.speechReady=true` 才自动 arm（`AUDIO_PROVIDER=none` 时自动 arm 会导致每次语句 503 刷错）；bootstrap 失败保持点按兜底。
- **常开开关**：`.local-set`（约 L490）「回答朗读」行后加「常开聆听」行，存储键 `znwd.listen`，**缺省 = 开**（`readStorage(...) !== '0'`，同 speak 键的镜像语义）；watcher → `dictation.setAlwaysOn(v)`；关时若在语句中 → 放弃 + 释放 + `onPartial(null)`。
- **麦克风按钮**：`:disabled` 保持（流式期间本来就被抑制）；always 下点按 = **立即结束当前语句**（capturing 时），否则 no-op；标签：`armed && !capturing` → 「聆听中…」，语句中沿用现有两段文案；`:class.on` 加上 `alwaysOn && armed`。
- **partial → draft**：`onPartial(text)`：非 null → `draft = text` 并记 `partialDraft`；null → 仅当 `draft === partialDraft` 时清空。`onText`（现有）→ draft=终稿、清 partialDraft、`submit()` 自动提问，链路不变。
- **闲置复位**：监听保持 armed（下一位参观者直接说话）；现有 `messages.length→0` watcher（约 L121）**不清 draft**（已核实是现状）——补：归零且 `partialDraft` 存在时 `draft=''`。
- **卸载**：`dictation.cancel()` 改为 `dispose()`（always 模式必须释放轨道），并触发遥测冲刷。
- **形象状态（顺手）**：`avatarState` 增加 `'listening'`（armed 且空闲）；`AvatarFigure.vue` 约 L12、`AvatarPortrait.vue` 约 L24 类名降级即可，无新动画。

**新 composable `web/src/composables/useAcoustics.ts`**：持有增量计数器累加器，每 15s + `visibilitychange`/卸载时 `fetch(keepalive:true)` POST `/api/speech/metrics`（用 `apiUrl`，非 `adminRequest`——无口令）；App 挂载即启动。

## D. 运营遥测 UI（`web/src/components/AdminPanel.vue`）

- 反馈表后（约 L98 与 uncovered `template` 之间）**内联块**，`v-if="stats?.speech"`，不新建子面板（纯展示，`load()` 已拉 stats 无需改）。
- 行：平均底噪（dB）· 语句数 · 自动/手动/超时结束 · 声学放弃 · 空识别误触 · 分段调用/失败/丢弃 · 分段平均延迟。
- `web/src/api/admin.ts`：`AdminStats` 增加 `speech?: Record<string, number>`。

## E. 测试

| 层 | 新用例 |
|---|---|
| `useDictation.spec.ts` | always：arm 一次 getUserMedia、语句间轨道不释放；假定时器下分段发射（**fake timers 必须先于 installBrowser**）；cancel 后过期分段丢弃；抑制冻结 VAD/底噪；空识别误触走 `onPartial(null)` 不触发 onError；tap 模式全部回归保持绿 |
| `App.spec.ts` | 键缺省 → 手势后 armed；`znwd.listen=0` → 仅点按；partial→draft→终稿自动提交；闲置复位清 partial draft；开关持久化 |
| `AdminPanel.spec.ts` | speech 行渲染（`stubApi` 按 URL 路由） |
| server test | 限流拆分（asr 桶 ≠ chat 桶）、metrics 校验 400/429、`Analytics.recordSpeech` + `stats().speech` 计算值 |

## F. 文档同步

本文件打勾/移入 archive、`docs/voice-realtime-plan.md`（P1 条目状态）、`docs/api.md`（新端点 + 限流语义变更）、`docs/development.md`/`README` 单测项数如涉及、`CHANGELOG.md` 未发布段、`server/.env.example`、`tools/security.py` 用例。

## 边界情况（实现时逐条对照）

1. 纯环境噪声 → 不成句，只进底噪采样；2. TTS 回声 → 抑制路径；3. 运营关开关撞上语句中 → 放弃无报错；4. 闲置复位 → 保持 armed、清 partial draft；5. 卸载 → dispose + keepalive 冲刷；6. 分段 429 → 静默计数，终稿 429 → 现有错误 UX；7. 终稿后迟到的 partial → generation 丢弃；8. 标签页节流 tick 合并 → MAX 分支已处理，遥测补报落在 30/min 内；9. recognizing 中又说话 → 新语句等 `busy=false`；10. 参观者手打字时 partial 覆盖 draft → 文档声明（展厅可接受）；11. getUserMedia 被拒 → 报一次错，下个手势才重试；12. `AUDIO_PROVIDER=none` → 不自动 arm，点按兜底不变；13. 终稿到达时正 streaming → `submit()` 现有 no-op，文本留在 draft。

## 验证

```bash
cd web && npx vitest run && npm run lint && npx vue-tsc -b
cd server && ../tools/mvn -B test        # git-bash 必须用 ../tools/mvn
py -3 tools/security.py                   # 需本地服务；tools/smoke.py 同（README 口径）
```

手动清单（本机 + 展厅）：
1. 首次触摸后免点按进入聆听；说话 → composer 里文字边出；停顿 ~1s 自动提交并语音回答。
2. 回答播放期间说话 → 不产生语句、底噪计数不涨；播放结束恢复聆听。
3. `?admin=1` 关「常开聆听」→ 回到点按模式；刷新后保持；再开 → 下次手势恢复常开。
4. 运营统计出现声学行（底噪/语句/误触/分段数），数值随现场说话变化。
5. 闲置 3 分钟 → 回欢迎态、partial draft 清空、麦克风仍 armed；关页面 → 麦克风指示熄灭。
6. `AUDIO_ASR_RATE_PER_MIN=2` 启动 → 分段静默失败计数增长、终稿 429 走现有错误提示。

## 关键文件

`web/src/composables/useDictation.ts`（重构核心）、`web/src/App.vue`、`web/src/composables/useAcoustics.ts`（新）、`web/src/components/AdminPanel.vue`、`web/src/api/admin.ts`、`server/src/main/java/com/znwd/hostess/web/SpeechController.java`、`…/config/AppProperties.java` + `AppConfig.java` + `resources/application.yml`、`…/analytics/Analytics.java`、`tools/security.py`。
