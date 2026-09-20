# 优化与新增清单（重构后）

记录重构后代码审查的结论：已修的、待做的。待做项按"展厅实际影响 × 成本"排序。

## 已修（第一轮，均有验证）

| 问题 | 影响 | 修法 |
| --- | --- | --- |
| `ChatLogMapper.insert` 用了 `#{promptTokens}`，而 `ChatLogEntry` 只有 `usage` 对象 | **每次问答的 chat_log 落库都在静默失败**（被 catch 成 warn），统计重启即清零 | 改成 `#{usage.promptTokens}` 等嵌套取值 |
| `FeedbackMapper.insert` 带 `@Options(useGeneratedKeys, keyProperty="id")`，record 无 id | 插入成功但抛异常、日志刷 warn | 去掉 `@Options` |
| `Analytics.logChat` 从不写 `uncovered_question` | 未覆盖问题清单只活在内存里，运营重启后拿不到补资料靶子 | 落库（单独一张表，保留期与内存窗口一致） |
| `Analytics.logChat/logFeedback` 持锁做数据库 I/O | 库慢会拖住所有问答请求（与"内存是热路径"的设计相矛盾） | 内存操作加锁、DB 写移到锁外 |
| 请求体非法 JSON 时回 `message is required` | `/api/feedback` 收到坏 body 会把排查方向指错 | 拆成独立 handler，回"请求体不是合法 JSON 对象" |
| `AdminGuard` 用 `String.equals` 比对口令 | 理论上可逐字节试探 | 改 `MessageDigest.isEqual` 常量时间比较 |
| `RateLimiter.evictExpired()` 无人调用 | 长时间运行后按 IP 的历史窗口不回收 | 挂到已有的定时清理任务上 |
| `FeedbackMapper.count/countUp` 无调用方 | 死代码 | 删除 |
| pom.xml 注释里出现 `--` | XML 注释非法，**所有 maven 命令直接失败** | 改注释文案 |
| 前端无闲置处理 | 大屏前换人后上一个参观者的对话还挂在屏幕上 | 闲置 3 分钟自动回到欢迎态 |
| `vite.config.ts` 用 `process.env` 但没装类型 | `npm run build` 类型检查失败 | 加 `@types/node` 并写进 tsconfig types |

## 已做（第二轮：工程资产与运维口子）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **标定工具**（原 `scripts/calibrate.ts` + `tune-scoring.mjs`） | `mvn -q test-compile exec:java@calibrate`。输出：在域/域外分数对照表、闸门区间建议、参数网格（`--grid`）、报告落 `docs/eval/calibration-*.json`；区间不成立时退出码 2，可当 CI 失败条件 | 实测：在域最低 **8.933** / 域外最高 **3.654** → 建议阈值 **6.3**（与生产 `.env` 一致，余量 0.58）；网格 **36 组没有一组超过当前默认**，确认 `ScoringOptions` 默认值仍是最优 |
| **检索诊断接口** `/api/admin/diagnostics?q=&topK=` | 走线上同一套索引与阈值，回 `gated/reason/两路分数/候选数/阈值/距阈值距离` + 一句人话结论（`RetrievalVerdict`），命中项带分数与命中词 | 实测：在域"叶片检测要停机吗"→ keyword 24.33 / 余量 18.03；域外"写一首夏天的诗"→ gated、距阈值 4.08 |
| **同义词表热更新** `GET/PUT /api/admin/synonyms` | 内置表 + `knowledge/_meta/synonyms.tsv` 覆盖；`PUT` 立即生效（查询期展开，无需重建索引）、可选落盘；`knowledge` reload 时一并重载 TSV | 冒烟探针实测：加一个 `ZWPROBE→叶片` 的临时映射后，探针问题的关键词分立刻从 0 抬起，还原后回到原值 |
| **评测/标定共用** `EvalSupport` | 用例解析、命中判定、域外样本、报告落盘只留一份，防"评测一套口径、标定另一套口径" | 改完重跑评测：top1 0.9333 / top3 0.9667 / 漏答 0，与改动前逐项一致 |
| 契约与元数据 | `openapi.json` 补两个新路径 + `Diagnostics`/`Synonyms` schema，版本 1.2.0（`/api/health` 同步）；`/api/knowledge/list` 增加同义词摘要 | `python tools/smoke.py` **56/56**（原 32 项，新增 24 项覆盖诊断与热更新） |
| 工具类输出编码 | Windows 控制台默认 GBK，评测/标定报告中文花屏 | 两个工具入口统一按 UTF-8 输出 |

### 标定暴露的两个事实（供后续决策）

- **召回天花板目前是 2 条漏例**：`wind-06`、`svc-05` 在任何参数组合下都进不了 top1（部分组合还会多漏 `mix-02`）。要提升只能补语料或补同义词，调参数无用。
- **默认阈值已按标定改成 6.3**（2026-09-20 决定）：3.8 是 23 块语料时代的中点，当前 134 块语料下的中点是 6.3，评测在 6.3 下闸门漏答为 0。三处已同步：`application.yml` 的 `MIN_RELEVANCE_SCORE` 默认值、`HybridRetriever.DEFAULT_MIN_KEYWORD_SCORE`、CI 的环境变量。同时把合成语料单测的阈值固定成自己的 3.8——它不该跟着生产阈值走，否则每次重新标定都会让闸门行为测试无辜变红。

## 待做

1. **资料入库工具**（旧 Node 版的 `npm run ingest`）**尚未移植**：PDF/Word/txt → markdown 的转换链路（`pdftotext -layout`、python-docx 保留标题层级与表格、规范化去页码/合并断行）在新栈里没有对应实现。当前只能外部转换后按展区目录手工落盘。仓库里也没有 `inbox/` 目录与相关依赖，按需再补。
2. **前端组件测试只覆盖了 App 的播报接线**：已加 `@vue/test-utils` + `jsdom` 并写了 `App.spec.ts`（朗读接线三条），但 `AdminPanel.vue` 与对话主流程的回归仍靠人工点；要继续补可直接沿用这套环境。
3. **（可选）指标暴露**：已带 `spring-boot-starter-actuator`（只暴露 `health,info`）；接多屏/后台要 Prometheus 指标时再接 `micrometer-registry-prometheus`。单机展厅当前 `/api/health` + `/api/stats` 够用。
4. **（可选）把标定挂进 CI**：区间塌了要早知道；但语料换成正式资料期间可能误报红，等资料稳定再加。
5. **本机 MySQL 还没初始化**：3306 上有 MySQL 在跑，但 `server/db/init.sql` 没执行过、`server/.env` 里也没有 `DB_*` 口令，所以 `/api/health` 报 `storageAvailable=false`（会话/统计/反馈不落库，重启即清零）。**链路已在临时实例（3307）上验通**：init.sql 的新权限能建表、问答与反馈各落一行、重启后会话与统计恢复；只剩「在你的正式实例上执行一次 init.sql 并填 DB_PASSWORD」这一步（需要你的管理员口令）。
6. **（可选）请求体大小上限**：消息正文会被截到 2000 字，但超大 JSON 仍会先进内存。建议反代加 `client_max_body_size 64k`，或加一个读 `Content-Length` 的过滤器。

## 已完成（第三轮：文档与配置换成新栈）

| 项 | 内容 |
| --- | --- |
| 文档全部重写 | `README.md`、`docs/{README,api,architecture,development,deployment,eval,knowledge}.md` 从 Node/Fastify + React 时代改成 Spring Boot + Vue 3 的写法（命令、路径、环境变量、接口字段逐条对着代码核对）；Node 时代的审查文档留在 `docs/archive/` |
| `server/.env.example` 修正 | 去掉新栈里已不存在的 `PERSIST_STATE`/`PERSIST_INTERVAL_SEC`（状态已落 MySQL）、补上原先完全缺失的 `DB_*` 全组、标定命令改成 `mvn exec:java@calibrate`、默认阈值改 6.3；键名以 `application.yml` 为准 |
| 阈值三处同步 | `application.yml` 默认值、`HybridRetriever.DEFAULT_MIN_KEYWORD_SCORE`、CI 环境变量都改为 6.3 |

## 已修（第四轮：配置接线 + 文档收尾）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **`NODE_ENV` 绑定失效 → 生产强制管理口令的安全规则从未生效** | `AppProperties.nodeEnv` 是 record 字段，relaxed binding 只认键 `znwd.node-env`，而 application.yml 里没有这个键；`.env` / 系统环境里的 `NODE_ENV` 是另一条独立键，绑不上。于是「生产（`NODE_ENV=production`）未配 `ADMIN_TOKEN` 的管理接口必须 401」这条规则静默失效——编译、启动、其余单测全都不报错 | application.yml 增加 `node-env: ${NODE_ENV:}`。实测两个场景：不设 `NODE_ENV` → `GET /api/stats` **200**（开发放行）；`NODE_ENV=production` 且未配口令 → **401** |
| 配置接线守卫测试 | 新增 `config/AppPropertiesBindingTest`：反射遍历 `AppProperties` 每个 record 字段，断言 application.yml 的 `znwd` 段里有对应 kebab-case 键；另有一条断言 `node-env` 必须显式绑 `${NODE_ENV:}` | 把 `node-env` 行临时删掉 → 该测试 **2 项失败**（确实拦得住这个 bug 类），恢复后通过 |
| 管理口令规则测试 | `HttpSupportTest` 补一条：`NODE_ENV` ∈ production/prod/staging（含大写）且未配口令必须 401；development/test/空 放行 | 单测 30 → **33 项全绿** |
| 文档收尾 | 根 `plan.md`（Node 时代交接文档）按仓库约定归档为 `docs/archive/old-node-plan.md` 并加归档说明；`knowledge/_meta/demo-docs.md` 里残留的 `npm run calibrate` / `npm run eval:retrieval` 换成新栈命令（并补 reload 一步）；README 与 docs 里的单测数 30 → 33；archive 索引补上归档计划文件 | `git status` 显示为 rename；全库 grep 已无旧栈命令 |

## 已完成（第五轮：浏览器语音播报）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **语音播报**（零依赖，Web Speech API） | 回答流式结束后整段朗读；右上角「朗读：开/关」切换，选择落 `localStorage`（默认开——展厅就是靠它讲解），朗读中出现「停读」按钮。三条现场取舍：**只读回答不读提问**、**流式结束才读**（边流边读会切成碎音）、**长文按句切片排队**（Chrome 对超长 utterance 会中途静默），并每 5 秒 `resume` 一次绕开 Chrome 约 15 秒后自动暂停的老毛病；朗读前先洗掉 Markdown 记号/链接/代码块；换问题、开新对话、闲置复位、组件卸载都会立刻停读。**行为对齐重写前的 React 版**（`web/src/hooks/useSpeech.ts`，原地重写时被丢掉）：默认开声、读完才读、可单独停读、`voiceschanged` 预热中文音色；新增的是切片排队、定时 resume 与文本清洗 | `web/src/composables/useSpeech.spec.ts` 10 项 + `web/src/App.spec.ts` 4 项（组件级接线：读完自动朗读、关掉一个字不读、新对话停读、停读按钮）；前端单测 7 → **27 项**；`npm run build`（vue-tsc + vite）通过 |
| 前端组件测试环境 | 新增 `@vue/test-utils` + `jsdom`（backlog 待做第 2 条要的就是这套）；`App.spec.ts` 用 `// @vitest-environment jsdom` 局部切换环境，node 环境的既有测试不受影响 | 全量 `npm test` 27/27 |
| 形象状态联动 | 语音播报期间虚拟形象保持「说话」态（`avatarState` 把 `speech.speaking` 并进去），读完回到空闲 | 组件测试覆盖（`speaking` 影响渲染分支） |

## 已修（第六轮：大屏可读性与界面细节）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| **大屏上出现字面的 Markdown 记号** | 模型习惯 `**粗体**` 与 `*` 分点，前端当纯文本渲染 → 屏幕上显示「检测**无需停机**」。两头一起治：system 提示词要求直接输出纯文本（分点用「1.」/「·」），前端新增 `format.ts` 把残留记号转成加粗片段与列表块（只产出结构、不产出 HTML，模型输出里的尖括号永远只是文字） | 真机（无头 Chrome + CDP）提问实测：回答里已无 `**`；`format.spec.ts` 6 项覆盖粗体/列表/分段/代码围栏/落单记号/空回答 |
| **流式回答不是响应式的** | `push` 进响应式数组的普通对象被代理，而流式回调改的是原始对象 → 字段变更不被追踪；以前靠 `streaming` 变化顺带重渲染才碰巧读到新值，模板里一旦有基于消息内容的 computed 就渲染空答案（本次加 `formatAnswer` computed 时暴露） | 改成 `reactive()` 创建回答对象；`App.spec.ts` 4 项（jsdom 下挂载真组件）通过 |
| 界面细节 | 形象区四边留白 14 → 34px（框变小、人物等比略缩，可见比例 `--frame-ratio` 不变）；主标题 15.5 → 17px、副标题 12px 拉开层级；展区下拉补自绘箭头；降级横幅退一档视觉重量；列表记号固定占宽，折行文字与首行严格对齐 |
| 展区下拉自绘 | 原生 `<select>` 的展开列表是系统绘制的，与浅色极简的页面风格割裂。换成自绘：触发按钮 + 白卡片列表，严格等宽对齐（实测左边缘/宽度差 0 px）、选中项蓝色文字 + 小圆点、分层分隔线、轻弹出动画（尊重 `prefers-reduced-motion`）、Esc 与点空白关闭、带 `role=listbox/option` 与 `aria-expanded` | 真机截图 + vision 逐条核对（对齐/分隔线/选中态/投影/箭头朝上）；`App.spec` 新增 1 条（展开、选中标记、选择后收起并带 `?zone=` 重取推荐问题、Esc 与点空白关闭） |
| 技术问题只走聊天窗口 | 删掉「数据库未连接…请按 init.sql 初始化」的降级横幅与单独的错误横幅：回答失败的技术原因落在同一条回答下方（「技术问题：…」带左竖线），落库状态挪进运营视图「本机设置 → 数据留存」。展厅大屏不给参观者看技术信息 | 实测：后端停掉后提问 → 聊天窗口里显示「这条问题暂时没能回答，请再试一次。」+「技术问题：请求失败（500）」，页面上 0 个横幅；`App.spec.ts` 补两条（未连接时页面不提示 / 失败时错误在消息里） |
| 展厅大屏做减法 | 去掉标题右侧四个入口（资料条数 / 朗读开关 / 新对话 / 运营视图）与输入框下方那行操作小字；输入框收成聊天软件那种单行高度（静止 39px）。**功能没删**：运营视图改由 `?admin=1` 打开，朗读开关与「重新开始」收进抽屉的「本机设置」，朗读中保留页面上的「停读」 | 无头 Chrome 截图逐轮对照（1600×900 与 700×1000 两种版面）：形象区留白评为「合适、不偏挤」，回答分点排版整齐、无溢出、无错位；控制台无报错 |

## 已修（第七轮：安全加固与降级模式）

| 项 | 内容 | 验证 |
| --- | --- | --- |
| 管理接口 fail-closed | 请求不是从本机回环地址进来且未配 `ADMIN_TOKEN` → 401（原来只有 `NODE_ENV=production` 强制，`HOST=0.0.0.0` + 忘配口令等于把统计/重载/诊断/同义词全对局域网开放）；`/api/health` 的 `adminTokenRequired` 与守卫同判据 | 实测绑 `0.0.0.0`：回环 `/api/stats` 200、经 LAN IP 401；单测 4 条（非回环/地址缺失/回环放行/健康上报一致） |
| CORS 错配 | 去掉 `access-control-allow-credentials`（`CORS_ORIGINS=*` 时回显任意 Origin + 允许携带凭据是经典错配；本服务不用 cookie） | 冒烟 56/56（不依赖该头） |
| `/api/feedback` 限流 | 公开写口纳入按 IP 限流（与两个 chat 接口共用一个桶） | 实测 `CHAT_RATE_PER_MIN=2` 时第 3 次 429；默认 30 时第 28 次起 429 |
| MySQL 最小权限 | `ALL PRIVILEGES` → `SELECT, INSERT, UPDATE, DELETE, CREATE`（仅 `znwd` 库） | 临时实例实测：建出 5 张表、问答 1 行 + 反馈 1 行、重启后恢复 |
| **降级模式写库白等 3 秒 + 日志刷屏** | 库挂掉时每次问答/反馈/定时裁剪都要等 Hikari `connection-timeout`（实测 3.0s/次），且 Hikari 每 65 秒刷一条建连 WARN + 16 行堆栈（同一根因反复刷，把真日志淹掉）。三层一起改：① 写路径与 `trimStorage` 都先问 `DatabaseStatus.shouldAttempt()`，已知不可用直接跳过；② `minimum-idle: 0` 去掉连接池的后台反复建连，另加每 60 秒的静默探活（恢复后无需重启即续写，health 也跟着变）；③ 压掉 `PoolBase` 每次重探的 WARN 堆栈（根因启动已报一次、health 如实上报） | 实测：反馈 3.0s → **0.019s**；降级静置 70 秒日志只有 **1 条 WARN、0 行堆栈**（原来约 3 段 ×16 行）；建库后**未重启**第 50 秒自动恢复落库，随后问答/反馈各落 1 行；单测 7 条 |
| 全仓安全核查 | 凭据、注入、XSS、管理面、日志、异常、Actuator 七项逐条核查（含命令） | 见 `docs/security.md` 第二、三节 |

## 已知取舍（不是 bug）

- `EMBED_PROVIDER=bag` 是特征哈希，不是语义向量：`/api/health` 会如实报 `semantic=false`、`degradedReason`，检索模式只报 `keyword`，不冒充 `hybrid`。要真语义检索需配 `openai_compat` 的 embedding 并 reload 重建索引。
- MySQL 不可用时服务照常讲解（不落库），`storageAvailable=false` 会在 `/api/health` 与前端顶部横幅同时提示——这是刻意降级，不是故障。
- 答案缓存只在"单轮且无历史"时命中（多轮上下文不同，复用会答错）。
- 诊断接口的 `q` 必须由调用方按 UTF-8 正确编码；在 GBK 控制台下用 curl 手拼中文会变成乱码（表现为"什么都被拦"），用 `python tools/smoke.py` 或浏览器访问可避免。
