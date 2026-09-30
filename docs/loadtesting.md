# 并发压测（tools/loadtest.py）

为什么要它：单测、smoke、security 都是「一条一条按顺序打」，证明不了多路并发下的会话隔离
（串话）、SSE 帧序、只读接口不受聊天限流牵连，以及观众硬断开后服务端还能接客。
真机演示前用它在 mock 或真实实例上短跑一次，比现场再试便宜。

## 1. 场景与判据

| 场景 | 参数（默认） | 动作 | 判据（任一不满足 = 本场景 FAIL） |
| --- | --- | --- | --- |
| 非流式并发 | `--n 8` | 每路独立 `sessionId` 问一个在域问题 | HTTP 200、`answer` 非空、响应回显 `sessionId` 与本路一致（串话=失败） |
| SSE 并发 | `--streams 4` | 每路独立 `sessionId` 打 `/api/chat/stream` | 首帧 `meta`、至少一帧 `delta`、末帧 `done` 且 `done.answer` 非空；`meta` 前出现 `delta` = 失败；会话回显一致 |
| 只读并发 | `--readers 4` | 问答/流式进行中同时打 `/api/health`、`/api/zones`、`/api/suggestions` | 全部 200（只读接口不受 `CHAT_RATE_PER_MIN` 影响；真被 429 波及按失败记） |
| 客户端中断 | 固定一次 | 发一条 SSE 后设 `SO_LINGER=0` 硬断开（RST），随后正常问一次 | 恢复的问答 200 且 `answer` 非空 |
| 无 5xx / 连接错误 | 汇总 | 全部请求 | 任一 5xx 或连接错误/超时 = 失败 |

会话回显口径：服务端当前把 `sessionId` 回显在 SSE 的 `meta` 帧上（`done` 帧带的是
`sessionToken`）；工具按「`done.sessionId` 有则必须一致，没有则以 `meta.sessionId` 判串话」执行，
两边都查，串话无处可藏。带 `--token`（或环境变量 `ADMIN_TOKEN`）时把管理只读的 `/api/stats`
也轮进只读并发；不带口令就不打它，免得拿 401 当失败。

## 2. 429 语义

- 429（聊天限流）是**预期行为，不算失败**，但单列计数：每场景报 `429 N`，汇总再报总数。
- 5xx、连接错误、超时（`--timeout`，默认 60s）、契约断言不过 = **失败**，退出码 1。
- 某场景一次成功样本都没有（全部 429）→ **判失败**（`全部 N 次都是 429，没有验到契约`）——
  限流窗口太小就不该报绿。
- 输出：每场景 PASS/FAIL、`req/ok/429/fail`、P50/P95、最多 5 条失败明细；结尾
  `通过 X 项，失败 Y 项`。

429 行为已用低限流实例（`CHAT_RATE_PER_MIN=5`）实测：首轮 `2 成功 + 2 次 429` 仍 PASS 且如实
计数；同一窗口内立刻复跑，非流式/SSE/中断三场景报
`全部 N 次都是 429，没有验到契约` 并退出码 1，只读并发照常 PASS。

## 3. 本地命令

先让服务跑起来（mock 或真实模型都行）：

```bash
py -3 tools/loadtest.py                                   # Windows：默认 http://127.0.0.1:8787，8+4+4
python tools/loadtest.py                                  # Linux/macOS（本机 Windows 命令不可用，用 py -3）
py -3 tools/loadtest.py --n 4 --streams 2                 # 默认限流 30/min 时降并发
py -3 tools/loadtest.py --base http://127.0.0.1:8899 --n 24 --streams 12 --rounds 1
ADMIN_TOKEN=<口令> py -3 tools/loadtest.py                # 带口令把 /api/stats 纳入只读并发
```

参数速查：`--base`（默认 `http://127.0.0.1:8787`）、`--n`、`--streams`、`--readers`、
`--rounds`（每路轮数，默认 1）、`--duration`（秒；给了就持续跑到时长到）、`--timeout`（单请求秒，
默认 60）、`--token`（默认环境变量 `ADMIN_TOKEN`）。

## 4. CI 命令

backend job 在「起服务并跑接口冒烟」之后**另起专用实例**（不复用主实例：它已被 smoke/security
打进限流窗口），抬高 `CHAT_RATE_PER_MIN` 让短跑验证并发正确性而不是限流：

```bash
HOST=127.0.0.1 PORT=8899 CHAT_RATE_PER_MIN=1000 LLM_PROVIDER=mock DATA_DIR=/tmp/data-load \
  java -jar server/target/hostess-server.jar --spring.main.banner-mode=off > /tmp/server-load.log 2>&1 &
# 等 /api/health 的 ok=true、ready=true、knowledgeChunks>0
python3 tools/loadtest.py --base http://127.0.0.1:8899 --n 24 --streams 12 --rounds 1
```

目标 <60s；失败时本步 `tail -60 /tmp/server-load.log`，日志也会被「上传日志与测试报告」的
`/tmp/server*.log` 一并带走。

## 5. 基线

「本次实跑输出为准」——2026-09-30 本机实测，mock 实例（`LLM_PROVIDER=mock`、
`EMBED_PROVIDER=bag`、`HOST=127.0.0.1 PORT=8899 CHAT_RATE_PER_MIN=1000`），CI 同参
`--n 24 --streams 12 --rounds 1`，总耗时 0.8s（远低于 CI 的 60s 目标）：

| 场景 | req | ok | 429 | fail | P50 | P95 |
| --- | --- | --- | --- | --- | --- | --- |
| 非流式并发 | 24 | 24 | 0 | 0 | 176ms | 214ms |
| SSE 并发 | 12 | 12 | 0 | 0 | 226ms | 250ms |
| 只读并发 | 81 | 81 | 0 | 0 | 21ms | 40ms |
| 客户端中断后恢复 | 1 | 1 | 0 | 0 | 110ms | 110ms |
| 合计 | 118 | 118 | 0 | 0 | — | — |

结果：`通过 5 项，失败 0 项`（退出码 0）。

真实模型实例（8787、`openai_compat` 云端）基线：**待补**。本次实跑时该实例是 13:52 启动的旧
进程，14:42 构建把它正在使用的 `hostess-server.jar` 覆盖后，JVM 无法再懒加载新类
（`NoClassDefFoundError: ch/qos/logback/classic/spi/ThrowableProxy`）。实跑
`--n 8 --streams 4 --rounds 1` 的结果：非流式 8/8、只读 12/12、中断恢复 1/1 全部
`TimeoutError('timed out')`，只有答案缓存命中的 SSE 4/4 通过，退出码 1——这是「jar 被
替换但进程没重启」的环境问题，不是压测工具的判据。实例健康后用同一命令复跑并把数字填回
这里；429 数量由 `CHAT_RATE_PER_MIN`（默认 30/min）决定。

## 6. 长跑（对应 TC-PERF-07）

```bash
py -3 tools/loadtest.py --duration 7200 --n 8 --streams 4 --readers 4
```

`--duration` 给了就一直跑到时长到（此时忽略 `--rounds`），每 30s 打一行进度；结束后同样按场景
报 PASS/FAIL 与 P50/P95。对应 `docs/test-cases.md` 的 TC-PERF-07（长时间运行 2 小时以上 + 周期
提问：无线程/内存持续增长、无 SSE 连接泄漏）。建议配 mock 或预算内的真实模型，期间观察
`/api/health` 的 `activeSessions`/`answerCacheSize` 与进程内存曲线。
