# 安全口径与检查记录

面向展厅部署的安全基线：**这一版做了什么、核过什么、还剩哪些已接受的风险**。每条都带复核命令，
不写没验过的结论。最近一次全面检查：2026-09-20。

## 一、本轮加固（都有测试或实测）

| 项 | 原来 | 现在 | 验证 |
| --- | --- | --- | --- |
| 管理接口鉴权 | 只有 `NODE_ENV=production` 或显式开关才强制口令；`HOST=0.0.0.0` + 忘配 `ADMIN_TOKEN` 时统计/重载/诊断/同义词**全对局域网开放** | 加 fail-closed：**请求不是从本机回环地址进来的**，未配口令一律 401（拿不到地址也按非本机处理） | 实测：绑 `0.0.0.0` 时回环 `/api/stats` **200**、经 LAN IP **401**；`/api/health` 的 `adminTokenRequired` 同判据上报；单测 4 条 |
| CORS | 回显 Origin 的同时声明 `access-control-allow-credentials: true`（`CORS_ORIGINS=*` 时是「任意站点 + 允许携带凭据」的经典错配） | 不再发该头（本服务不用 cookie，管理口令走 `Authorization`，不需要它） | 冒烟不依赖该头；预检仍放行 `content-type,authorization` |
| `/api/feedback` | 无鉴权的公开写口，且不过限流 → 可刷统计与反馈 | 过同一套按 IP 限流（与两个 chat 接口共用一个桶） | 实测：`CHAT_RATE_PER_MIN=2` 时第 3 次即 429；默认 30 时第 28 次起 429 |
| MySQL 账号权限 | `GRANT ALL PRIVILEGES ON znwd.*` | 收窄到 `SELECT, INSERT, UPDATE, DELETE, CREATE`（建表靠 `CREATE`；不给 DROP/ALTER/LOCK TABLES/GRANT） | 临时实例（3307）实测：用该账号建出 5 张表、问答与反馈各落 1 行、重启后会话与统计恢复 |
| 降级模式写库 | 库挂掉时**每次问答/反馈白等 Hikari `connection-timeout`（实测 3.0 秒/次）**，文档却写着「照常讲解」 | 写路径先问 `DatabaseStatus.shouldAttempt()`：已知不可用就跳过（毫秒级返回），最多每 60 秒重探一次，库恢复自动接着落库 | 实测：降级模式下反馈 3.0s → **0.019s**；单测 5 条（含「不可用时不写、可用时照写、内存上下文不受影响」） |

## 二、已核查、确认没问题（含复核命令）

- **凭据不进库**：被追踪的只有 `server/.env.example`（模板，无真实值）；全历史 `--diff-filter=A` 里也没有 `.env`；`.env` 被 `.gitignore` 忽略。
  `git ls-files | grep -iE "\.env|secret|credential"; git log --all --diff-filter=A --name-only | sort -u | grep -iE "\.env|secret"`
- **代码里没有硬编码密钥**：`git grep -nE "sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}"` 无命中。
- **前端产物不含密钥**：`grep -oE "sk-|ghp_|LLM_API_KEY" web/dist/assets/*.js` 只命中 `ADMIN_TOKEN`（是输入框占位文案，不是值）。
- **SQL 注入**：全仓无 MyBatis `${}` 拼接，全部 `#{}` 参数绑定（`grep -rn '\${' server/src/main/java`）。
- **XSS**：前端无 `v-html` / `innerHTML` / `eval`；模型输出经 `format.ts` 只产出「段落 + 粗体片段」结构，由模板渲染，尖括号永远只是文字。
- **管理面完整**：7 个受保护接口（`/api/stats`、`/api/admin/{uncovered,feedback-stats,diagnostics,synonyms}`、`/api/knowledge/reload`、`PUT /api/admin/synonyms`）全部过 `AdminGuard`；口令比对用 `MessageDigest.isEqual` 常量时间。
- **日志隐私**：默认 `LOG_MESSAGE_MODE=hash`，落盘的是 `hash#长度#前 20 字`，不是整段提问；需要排查时显式改 preview。
- **异常不外泄**：统一错误信封 `{error,message,requestId}`，5xx 固定文案「服务内部错误」，堆栈只进服务端日志。
- **Actuator 面最小**：只暴露 `health,info`（`management.endpoints.web.exposure.include`）。

## 三、已接受的风险（不是疏忽，是权衡）

1. **`/api/knowledge/list` 无鉴权**：它是对外契约的一部分（冒烟脚本在跑），会返回知识文件名、分块数与同义词摘要。局域网展厅内泄露面很小；要收紧就给它加 `AdminGuard` 并让冒烟带 token。
2. **`/api/health` 暴露绝对路径**（`knowledgeDir`/`dataDir`/索引文件）：运营排查要用。若部署在不受控网络，建议在反代层只放行 `/api/chat*` 与 `/`，其余接口限内网。
3. **请求体无大小上限**：消息正文会被截到 2000 字，但超大 JSON 仍会先进内存（Tomcat 的 `maxPostSize` 只管表单）。建议在反代加 `client_max_body_size 64k`，或加一个读 `Content-Length` 的过滤器。
4. **日志保留提问前 20 字**：可读性与隐私的折中，可用 `LOG_MESSAGE_MODE` 调到纯 hash。
5. **启动窗口竞态**：`/api/health` 在 `ApplicationReadyEvent` 的会话恢复完成前就可能回 200，这段时间 `GET /api/sessions/{id}` 可能 404（影响：重启后头几百毫秒的追问拿不到上文）。展厅重启不频繁，暂不改。

## 四、上线检查清单（展厅部署前逐条过）

1. `server/.env` 里配 **`ADMIN_TOKEN`**（长随机串）。绑 `0.0.0.0` 时没配口令，管理接口会一律 401——运营视图会打不开，这是**故意**的。
2. `CORS_ORIGINS` 显式写展厅前端地址（不要图省事写 `*`）；不写只放行 localhost。
3. 用 `server/db/init.sql` 建库建号（口令改掉 `CHANGE_ME_znwd`），把同一口令填进 `DB_PASSWORD`；确认 `GET /api/health` 的 `storageAvailable=true`。
4. 部署机防火墙只放开展厅要用的端口；`HOST` 默认 `127.0.0.1`，要跨机访问再显式改 `0.0.0.0` 并配反代。
5. 装完跑一遍：`python tools/smoke.py`（56 项）与 `docs/deployment.md` 的巡检清单。
6. 运营视图用 `?admin=1` 打开，口令只存 sessionStorage（不进 URL、不进日志）。

## 五、自己再验一遍（复核命令）

```bash
# 1) 管理接口 fail-closed：绑 0.0.0.0 起服务，再分别从回环与 LAN 打
cd server && HOST=0.0.0.0 PORT=8899 ../tools/mvn -B spring-boot:run
curl -s -o /dev/null -w 'loopback %{http_code}\n' http://127.0.0.1:8899/api/stats   # 200（开发态）
curl -s -o /dev/null -w 'lan      %{http_code}\n' http://<本机LAN IP>:8899/api/stats # 401（fail-closed）

# 2) 凭据与注入面
git ls-files | grep -iE "\.env|secret|credential"      # 只应出现 .env.example
git grep -nE "sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}"
grep -rn "v-html\|innerHTML\|eval(" web/src             # 应为空

# 3) 落库与最小权限（用临时实例，不碰正式库；脚本见 spring-boot-development 技能）
#    参考：docs/optimization-backlog.md 第七轮里的验证步骤

# 4) 回归
cd server && ../tools/mvn -B test                        # 42 项
cd web && npm test                                       # 30 项
python tools/smoke.py                                    # 56 项（需服务在跑）
```
