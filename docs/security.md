# 安全口径与检查记录

面向展厅部署的安全基线：**这一版做了什么、核过什么、还剩哪些已接受的风险**。每条都带复核命令，
不写没验过的结论。最近一次全面检查：2026-09-29；同日补充会话归属（`sessionToken`）与 `/api/feedback` 独立限流桶两条并复跑全部黑盒。

## 一、本轮加固（都有测试或实测）

| 项 | 原来 | 现在 | 验证 |
| --- | --- | --- | --- |
| 管理接口鉴权 | 只有 `NODE_ENV=production` 或显式开关才强制口令；`HOST=0.0.0.0` + 忘配 `ADMIN_TOKEN` 时统计/重载/诊断/同义词**全对局域网开放** | 默认 `REQUIRE_ADMIN_TOKEN=true`；按连接对端 `remoteAddr`（不是 `localAddr`）判断回环；未配口令时所有管理请求默认 401，只有显式开发配置才放行回环请求 | 配置绑定测试 + 管理守卫测试 |
| CORS | 回显 Origin 的同时声明 `access-control-allow-credentials: true`（`CORS_ORIGINS=*` 时是「任意站点 + 允许携带凭据」的经典错配） | 不再发该头（本服务不用 cookie，管理口令走 `Authorization`，不需要它）；预检方法包含 `PUT` | 冒烟不依赖该头；预检放行 `GET,POST,PUT,DELETE,OPTIONS` 与 `content-type,authorization` |
| `/api/feedback` | 无鉴权的公开写口，且不过限流 → 可刷统计与反馈 | 走独立限流桶 `FEEDBACK_RATE_PER_MIN`（默认 10/分钟，与 chat 的 30 分开）——原来共用 chat 桶，一条长回答或一波刷反馈会把访客提问一起限掉 | 实测：`FEEDBACK_RATE_PER_MIN=2` 时第 3 次即 429；默认 10 时第 11 次起 429 |
| MySQL 账号权限 | `GRANT ALL PRIVILEGES ON znwd.*` | 收窄到 `SELECT, INSERT, UPDATE, DELETE, CREATE`（建表靠 `CREATE`；不给 DROP/ALTER/LOCK TABLES/GRANT） | 临时实例（3307）实测：用该账号建出 5 张表、问答与反馈各落 1 行、重启后会话与统计恢复 |
| 会话接口归属 | `GET/DELETE /api/sessions/:id` 只凭 `sessionId` 放行，知道 id 就能读/删（**已接受风险**） | 问答响应下发会话令牌（非流式字段 `sessionToken`、SSE 挂 `done` 帧），客户端用 `X-Session-Token` 头或 `?sessionToken=` 带回来；不匹配一律 404 | 2026-09-29 实测：无令牌/错令牌删除 404、持令牌读 200、持令牌删 200；`ChatWebContractTest` 4 条单测 + `tools/security.py` S19/S19a–d |
| 降级模式（写库 + 日志） | 库挂掉时**每次问答/反馈/定时裁剪白等 Hikari `connection-timeout`（实测 3.0 秒/次）**，且连接池每 65 秒刷一条建连 WARN + 16 行堆栈（同一根因反复刷屏，真日志被淹） | 写路径与 `trimStorage` 先问 `DatabaseStatus.shouldAttempt()`；`minimum-idle: 0` 去掉后台反复建连；压掉 `PoolBase` 的重探 WARN；新增每 60 秒静默探活（恢复后无需重启即续写） | 实测：反馈 3.0s → **0.019s**；降级静置 70 秒日志 = 1 条 WARN + **0 行堆栈**；建库后未重启第 50 秒自动恢复并落库 4 行；单测 7 条 |
| 安全响应头 | 只有 `x-content-type-options: nosniff`；页面可被任意站点套 iframe（点按劫持/钓鱼），跨站跳转不带 Referrer 策略 | `CorsAndIdFilter` 对**所有响应**（页面/接口/错误/SSE/预检）统一加 `x-frame-options: DENY` 与 `referrer-policy: no-referrer`，nosniff 保留 | `SecurityHardeningTest` 3 条（普通请求/预检/弱口令判定）+ `tools/security.py` S09b/S09c（黑盒，打活实例） |
| 弱管理口令启动告警 | 口令配短了或用了示例值（如 `root:123456`）没有任何提示，展厅上局域网时才暴露 | 启动时 `AdminTokenStrength.isWeak()` 判定，弱则打醒目 WARN（**不阻止启动、不改 `AdminGuard` 判据**）；`.env.example` 注明至少 16 位随机串 | `SecurityHardeningTest` 的弱口令判定用例 |

## 二、已核查、确认没问题（含复核命令）

- **凭据不进库**：被追踪的只有 `server/.env.example`（模板，无真实值）；全历史 `--diff-filter=A` 里也没有 `.env`；`.env` 被 `.gitignore` 忽略。
  `git ls-files | grep -iE "\.env|secret|credential"; git log --all --diff-filter=A --name-only | sort -u | grep -iE "\.env|secret"`
- **代码里没有硬编码密钥**：`git grep -nE "sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}"` 无命中。
- **前端产物不含密钥**：`grep -oE "sk-|ghp_|LLM_API_KEY" web/dist/assets/*.js` 只命中 `ADMIN_TOKEN`（是输入框占位文案，不是值）。
- **SQL 注入**：全仓无 MyBatis `${}` 拼接，全部 `#{}` 参数绑定（`grep -rn '\${' server/src/main/java`）。
- **XSS**：前端无 `v-html` / `innerHTML` / `eval`；模型输出经 `format.ts` 只产出「段落 + 粗体片段」结构，由模板渲染，尖括号永远只是文字。
- **管理面完整**：8 个受保护接口（`/api/stats`、`/api/admin/{uncovered,feedback-stats,diagnostics,synonyms}`、`/api/knowledge/reload`、`PUT /api/admin/synonyms`、`/api/knowledge/list`）全部过 `AdminGuard`；口令比对用 `MessageDigest.isEqual` 常量时间。`/api/knowledge/list` 历史上漏了守卫，现已补齐（`tools/security.py` 的 `ADMIN_PATHS` 盯着它 fail-closed）。
- **日志隐私**：默认 `LOG_MESSAGE_MODE=hash`，落盘的是 `hash#长度#前 20 字`，不是整段提问；需要排查时显式改 preview。
- **异常不外泄**：统一错误信封 `{error,message,requestId}`，5xx 固定文案「服务内部错误」，堆栈只进服务端日志。
- **Actuator 面最小**：暴露 `health,info,prometheus`（`management.endpoints.web.exposure.include`，实配见 `application.yml`）。其中 `prometheus` **无鉴权**：默认只监听 `127.0.0.1` 时同机抓取安全；跨机或 `HOST=0.0.0.0` 必须由反代限源（IP 白名单），否则从 include 里去掉 `prometheus` 关闭暴露（口径同 `docs/architecture.md`、`docs/deployment.md`）。
- **启动就绪可判定**：`GET /api/health` 始终返回 HTTP 200，但知识快照加载完成前 `ok=false`、`ready=false`；部署探活与自动化必须解析 JSON，不能只看端口或状态码。需要落库的流程还应同时确认 `storageAvailable=true`。
- **出网适配器有白名单**：`tools/offline-check.py` 的 O04 只允许 `llm/OpenAiCompatChatModel`、`embedding/OpenAiCompatEmbeddingProvider`、`audio/MimoSpeechModel` 三个后端文件发起网络连接；其它 Java 文件出现 HTTP/Socket 调用即失败。`AUDIO_PROVIDER=none` 默认不触发语音出网。
- **检索回归有门禁**：CI 用 `--baseline=docs/eval/baseline-java.json` 逐例守住 top1 路径、top1/top3、闸门指标与漏答数；`MIN_VECTOR_SCORE` 默认 `0.75`，启用语义路时 `--gate-check` 另守域外最高余弦不得越线。
- **请求体上限**：`RequestSizeLimitFilter` 拦下超过 64KB 的写请求（413 + 统一错误信封），避免超大 JSON 先进内存；无 `Content-Length` 的写请求一律按超限处理。`/api/speech/*` 放宽到 2MB（录音 base64 会超 64KB），其余写请求仍 64KB。
- **限流键默认不信任 `X-Forwarded-For`**：该头客户端可写，采信它等于让调用方自己挑限流桶（每次换一个值就是一个新桶，`CHAT_RATE_PER_MIN` 失效）。默认取 `remoteAddr`；仅当显式 `TRUST_FORWARDED_FOR=true`（且反代会剥离同名头）时才取转发头首个地址。实测：默认配置下每次换伪造头仍第 31 次 429；开关打开后 35 次不同头各自成桶。

## 三、已接受的风险（不是疏忽，是权衡）

1. **`/api/health` 暴露绝对路径**（`knowledgeDir`/`dataDir`/索引文件）：运营排查要用。若部署在不受控网络，建议在反代层只放行 `/api/chat*` 与 `/`，其余接口限内网。
2. **请求体上限只做在应用层（默认 64KB，`/api/speech/*` 放宽到 2MB）**：消息正文会被截到 2000 字，超大 JSON 已在过滤器里被 413 拦掉；`/api/speech/*` 因录音 base64 会超 64KB，是过滤器里唯一的放宽例外；反代侧仍建议按同一口径再加一道限制（其余路径 64k、`/api/speech/*` 不低于 2m，两道防线不冲突）。
3. **日志保留提问前 20 字**：可读性与隐私的折中，可用 `LOG_MESSAGE_MODE` 调到纯 hash。
4. **会话令牌的持有者等价于会话所有者**（2026-09-29 收紧后）：`GET/DELETE /api/sessions/{id}` 现在要求带 `X-Session-Token`（或 `?sessionToken=`）且与会话建立时下发的令牌一致，否则一律 404。残留取舍：令牌存在前端内存与 `sessionStorage`，同一台一体机上能读到该令牌的人（例如共用浏览器的下一位访客用开发者工具）仍能读到那段对话；展厅单屏、内网、无敏感内容，接受。要再收紧就换签名 cookie 或服务端 owner 绑定（见 `docs/security-testing.md` 已接受风险表）。
5. **启动窗口仍需读 JSON**：`/api/health` 在 `ApplicationReadyEvent` 完成前就可能可达，知识快照未发布时虽回 HTTP 200，但 `ready=false`。只看状态码仍会误判启动完成；至少等 `ready=true`，依赖落库的启动流程还要确认 `storageAvailable=true`。

> 原第 1 条「`/api/knowledge/list` 无鉴权」**已收紧**：该接口现在过 `AdminGuard`（见「二、已核查」的管理面完整），冒烟脚本也改成带 `ADMIN_TOKEN` 才跑得满管理块。

## 四、上线检查清单（展厅部署前逐条过）

1. `server/.env` 里配 **`ADMIN_TOKEN`**（长随机串）。默认 `REQUIRE_ADMIN_TOKEN=true`，未配口令时管理接口一律 401——运营视图会打不开，这是**故意**的。
2. `CORS_ORIGINS` 显式写展厅前端地址（不要图省事写 `*`）；不写只放行 localhost。
3. 用 `server/db/init.sql` 建库建号（口令改掉 `CHANGE_ME_znwd`），把同一口令填进 `DB_PASSWORD`；确认 `GET /api/health` 的 `ok=true`、`ready=true`、`storageAvailable=true`。
4. 部署机防火墙只放开展厅要用的端口；`HOST` 默认 `127.0.0.1`，要跨机访问再显式改 `0.0.0.0` 并配反代。
5. 装完跑一遍：`python tools/smoke.py`（带 `ADMIN_TOKEN` 且语音启用时满跑 100 项）与 `docs/deployment.md` 的巡检清单。
6. 运营视图用 `?admin=1` 打开，口令只存 sessionStorage（不进 URL、不进日志）。

## 五、自己再验一遍（复核命令）

```bash
# 1) 管理接口 fail-closed：默认未配口令时，回环与 LAN 都应 401
cd server && HOST=0.0.0.0 PORT=8899 ../tools/mvn -B spring-boot:run
curl -s -o /dev/null -w 'loopback %{http_code}\n' http://127.0.0.1:8899/api/stats   # 401（默认强制）
curl -s -o /dev/null -w 'lan      %{http_code}\n' http://<本机LAN IP>:8899/api/stats # 401（fail-closed）
# 仅可信开发环境显式 REQUIRE_ADMIN_TOKEN=false 后，回环才为 200

# 2) 凭据与注入面
git ls-files | grep -iE "\.env|secret|credential"      # 只应出现 .env.example
git grep -nE "sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}"
grep -rn "v-html\|innerHTML\|eval(" web/src             # 应为空

# 3) 落库与最小权限（用临时实例，不碰正式库；脚本见 spring-boot-development 技能）
#    参考：docs/optimization-backlog.md 第七轮里的验证步骤

# 4) 回归（检索改动必须过已提交基线门禁）
cd server && ../tools/mvn -B test
cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write --baseline=docs/eval/baseline-java.json"
cd server && ../tools/mvn -B test-compile exec:java@calibrate -Dexec.args="--gate-check --no-write"
cd web && npm test
python tools/smoke.py                                    # 需服务在跑
```
