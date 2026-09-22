# 修复计划：语音播报「没启动」

状态：**P0 / P1 / P2 已修并复验**（2026-09-22）。复验数据见下方「实测证据」的复验表与「验收结果」。相关代码：`web/src/composables/useSpeech.ts`、`web/src/App.vue`、`web/src/components/AdminPanel.vue`。

## 现象

展厅页面上提问、回答正常显示，但**一声不响**：既没有声音，页面上也不出现「停读」，运营视图的「最近的技术问题」里也没有任何记录。失败是完全静默的。

## 根因（实测，2026-09-22）

播报本身是通的——真机浏览器 + 真实点击下两处都验证出声了（见下节）。不发声只有三条机理：

| # | 机理 | 触发场景 | 观测结果 |
| --- | --- | --- | --- |
| 1 | **浏览器自动播放策略：`speechSynthesis.speak()` 需要用户激活** | 提问由脚本/控制台/自动化触发（合成事件，非真人点击）；或页面自行发起播报 | 应用照常调 `speak()`、中文音色也选对了，但每段 utterance 立刻 `error="not-allowed"`；`speaking` 始终 false、页面上不出现「停读」 |
| 2 | **朗读开关被关过（`localStorage['znwd.speak']='0'`）** | 之前有人在运营抽屉里点过「关」 | `speak()` 一次都没被调用（`useSpeech.ts:178` 直接 return）；而该开关现在只在 `?admin=1` 抽屉里，大屏上完全看不见 |
| 3 | 浏览器没有中文音色 / 无音频输出设备 / 系统静音 | 换机器、外接音箱没接对 | 不属于代码问题，但同样表现为「没声音」 |

机理 1 与 2 在页面上**表现完全一样**，只有把 `speak()` 调用与 utterance 的 `onerror` 记录下来才能区分——现在的代码把两者都吞掉了（`useSpeech.ts:201` 的 `onerror` 只把 `speaking` 复位，不记日志、不进技术问题列表）。

推论（设计约束，不是 bug）：**「页面一打开就自动播报欢迎语」在浏览器里做不到**，必须等一次真实点击/触摸。展厅若要无人值守出声，只能让参观者先点一下（例如欢迎屏放一个「点我开始」），或改走后端 TTS 生成音频（但音频自动播放同样受策略限制）。

## 实测证据

环境：本机 Chrome 153.0.8010.48 与 Edge 153.0.4234.48，无头 `--headless=new`，临时 profile（`--remote-debugging-port`），CDP 注入 spy 记录 `speak/cancel/onstart/onend/onerror`，再点推荐问题提问（后端 :8787、前端 :5173 都在跑）。

| 场景 | 触发方式 | 结果 |
| --- | --- | --- |
| A | **CDP `Input.dispatchMouseEvent` 可信点击**（= 真人点击） | `speakCalls=3, starts=1, cancels=2, errors=[]`，音色 `Microsoft Huihui - Chinese (Simplified, PRC)`，回答切成 3 段排队播报，页面出现「停读」。Chrome 与 Edge 都是这个结果 |
| B | `element.click()` 合成点击（无用户激活） | `speakCalls=3, starts=0, errors=["not-allowed","not-allowed","not-allowed"]`，`speaking=false`，页面无「停读」 |
| C | 预置 `localStorage['znwd.speak']='0'` 后提问 | `speakCalls=[]`（一次都没调），`cancels=1` |

**2026-09-22 复验（同一套探针重跑，四场景）**：

| 场景 | 触发方式 | 结果 |
| --- | --- | --- |
| A | CDP 可信点击推荐问题 | `speakCalls=4, starts=1, cancels=2, errors=[]`，音色 Huihui，4 段排队播报，`speaking=true` —— **真人操作路径完全正常** |
| B | `element.click()` 合成点击 | `speakCalls=3, starts=0, errors=[not-allowed ×3]`，`speaking=false`，页面无「停读」—— 机理 1 仍在 |
| C | `localStorage['znwd.speak']='0'` | `speakCalls=[]`（一次都没调），`cancels=1`，页面上看不出朗读是关的 —— 机理 2 仍在 |
| D | 可信点击提问 + 播报中点「停读」 | 播报一开始「停读」就出现；点击后 `speaking=false`、按钮消失、`localStorage` 没被改成 `0`（停读 ≠ 静音）；`errors=[interrupted]` 是停读的正常语义 |

本机中文音色 6 个（Huihui / Kangkang / Yaoyao / Google 普通话·粤语·國語），机理 3 在本机不成立。

两条现场推论：

- **展厅交互流程天然满足用户激活**：播报只在流式回答结束后触发，而流式回答必然由参观者的一次真实点击/触摸发起，
  所以 A 是常态、B 只在脚本或自动化触发时出现——这解释了「手测没问题」。
- **C 是真会踩到的**：开关藏在 `?admin=1` 抽屉里，大屏上看不出状态，表现同样是「一声不响」。P0（让失败可见）
  与 P2（开关状态摆出来）的价值就在这里。

环境侧确认：本机 SAPI 装有 `Microsoft Huihui Desktop (zh-CN)` 与 `Microsoft Zira Desktop (en-US)`；Chrome 另有 22 个音色（含 Google 普通话/粤语/國語）；`/api/health` 与前端代理均正常，与播报无关。

复现脚本（探针，未入库）：`C:\Users\18434\AppData\Local\hermes\cache\scratch\speech_probe{2,3,4}.py`
（2 = 可信点击走完整问答；3 = 合成点击与改写 localStorage 两个失败场景；4 = 可信点击 + 停读按钮）。
跑之前注意：探针复用同一个 Chrome profile，**上一个探针写进 `localStorage['znwd.speak']='0'` 会残留**，
下一次跑会表现为「一个字都不读」——脚本里已加 `removeItem` 清场。临时 profile 与调试浏览器已清理。

## 修复方案

### P0 让失败可见（必做，改动最小）——已完成

- `useSpeech.ts`：`onerror` 里把 `event.error`（如 `not-allowed`、`interrupted`、`canceled`）记下来，通过回调/返回值暴露给上层；同时 `console.warn` 一次，便于现场开 DevTools 就能看到。
- `App.vue`：把播报失败接到已有的「最近的技术问题」通道（`chat.errors`，运营视图可见），文案给运营看的人话，例如「浏览器拦下了自动播报（页面需要一次真实点击/触摸）」。
- 判据：合成点击场景下，运营抽屉里能看到这条记录；真人点击场景下没有记录。

### P1 首次真实手势解锁（必做，成本低）——已完成

- `App.vue` 已有首次交互监听（`pointerdown/keydown`，见 `onMounted` 里的 `bumpActivity`）：在第一次真实手势里调用一次 `speech.unlock()`——播出一段**空 utterance**（`new SpeechSynthesisUtterance('')`）并顺手 `warmVoice()`，把用户激活与音色列表都提前拿到，正式播报时不再被拒。
- 判据：暖机后，即便后续提问由脚本触发也不再 `not-allowed`（可复现验证）。

### P2 把开关状态摆到运营能看到的地方（建议）——已完成

- 运营抽屉「本机设置」里：显示当前值（现在是「开/关」按钮，看不出默认态），并加一句「本机设置；浏览器可能拦截自动播报」；被 P0 判定为拒绝时，在这行挂一个醒目标记。
- 大屏版式不变（不新增入口，遵守此前「大屏做减法」的约定）。

### 不做

- 不改切片、每 5 秒 `resume`、Markdown 清洗这三处逻辑——实测它们工作正常（3 段排队、`cancels=2` 是正常的逐条替换）。
- 不动音色选择逻辑（`warmVoice` 实测已选中中文音色）。
- 不引入后端 TTS：当前没有「零交互自动出声」的硬需求；若将来要，单独立项（后端合成 + 页面播放仍需要一次手势）。

## 验收标准

1. `npm test` 全绿，并新增/补齐 `useSpeech.spec.ts` 的「`not-allowed` 会上报」与 `App.spec.ts` 的「失败进技术问题列表」两条用例。
2. 真人点击（CDP 可信点击）提问：`starts≥1`、有声音、出现「停读」——与本次实测 A 一致。
3. 合成点击提问：技术问题列表里出现「浏览器拦下了自动播报」；不再静默。
4. 预置 `znwd.speak=0` 提问：抽屉里能一眼看出朗读是关的。
5. 前端 `npm run build`（vue-tsc + vite）通过。

## 验收结果（2026-09-22 实测）

| 判据 | 结果 |
| --- | --- |
| `npm test` 全绿并补齐用例 | **61 项全绿**（新增 6 条：`not-allowed` 会上报、`interrupted/canceled` 不上报、成功播报清掉旧标记、`unlock()` 静默暖机、首次手势只解一次、失败进技术问题列表）；`npm run build` 通过 |
| 真人点击（CDP 可信点击）提问 | `speakCalls=5`（1 条解锁 + 4 段回答）、`starts=1`、音色 Huihui、`speaking=true`、console 无错误；「停读」按钮出现且点击后立即停（`errors=[interrupted]` 属正常语义） |
| 合成点击提问 | 技术问题列表出现「（语音播报）浏览器拦下了自动播报（not-allowed）：页面需要一次真实点击/触摸」，**大屏上不出现**；运营视图的朗读开关下方同步标红 |
| 预置 `znwd.speak=0` 提问 | 运营抽屉里「回答朗读」显示「关」并带「本机设置；浏览器可能拦截自动播报」说明 |

实现要点：

- `useSpeech` 的 `onerror` 只把 **not-allowed 这类真失败**通过 `onError` 回调报出去；`interrupted` / `canceled`
  是我们自己停读的正常语义（换问题、点停读、开新对话），报出来只会把运营视图淹掉。
- `unlock()` 在**第一次真实手势**（pointerdown/keydown，只解一次）时播一段 `volume=0` 的空 utterance，
  把用户激活配额与中文音色提前拿到；失败路径无副作用。
- 播报失败复用**已有的技术问题通道**（`useChat.logError`），与回答失败同一处展示，不再新增横幅或面板。

## 影响面

- 只碰前端两个文件（外加可能的 `useChat.ts` 错误通道复用）；后端、检索、知识库、接口契约均不动。
- 若把探针脚本收进 `tools/`（可选，建议做）：它是一个「播报接线是否真的通」的端到端检查，能防住这次这类静默回归；注意它需要 CDP + 本地浏览器，不适合进常规 CI。
