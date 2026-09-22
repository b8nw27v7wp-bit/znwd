# 检索评测与阈值标定

评测回答一个问题：**「这次改动有没有让检索变差」**；标定回答另一个：**「闸门阈值还合不合适」**。
两者共用同一批用例与同一个命中口径（`EvalSupport`），并走 Spring 容器里**线上同一套**知识/同义词/阈值——评测说 0.93、标定按另一套口径建议调阈值，是谁也不敢信的状态。

## 1. 评测口径

用例文件：`server/eval/retrieval-cases.json`，两块：

| 字段 | 含义 |
| --- | --- |
| `cases` | 单轮用例：`{ id, question, zone?, sourcePathIncludes? }` |
| `followUps` | 多轮用例：`{ id, question, context }`，`context` 是上一轮原话，用于验证指代/省略句改写 |

**命中判定**（与旧实现一致）：`expectZone` 与命中块的 `zone` 相同，**或** `sourcePathIncludes` 是命中块 `sourcePath` 的子串——任一成立即算命中。只带 `zone`/`sourcePathIncludes` 的用例参与计分（`scored`）。

## 2. 跑评测

```bash
cd server
../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write"     # 只打印，不写报告
../tools/mvn -B test-compile exec:java@eval                             # 同时写 docs/eval/retrieval-java-<时间戳>.json
../tools/mvn -B test-compile exec:java@eval -Dexec.args="--baseline=docs/eval/baseline-java.json"
```

参数：`--no-write`（不落报告）、`--baseline=<路径>`（与历史基线对比）。
为什么走 exec 插件而不是 `java -cp`：评测类在 `test` 作用域，`classpathScope=test` 才能拿到测试依赖；`exec:java` 还会把 Spring 容器完整起起来（无 DB 也能跑）。

## 3. 指标

| 指标 | 含义 | 当前基线 |
| --- | --- | --- |
| `top1Rate` | 第一条命中即算命中 | **1.0**（46 条计分用例全部命中） |
| `top3Rate` | 前三里有命中 | **1.0** |
| `gateBlockedCount` | 在域用例被闸门误拦的条数 | **0** |
| `followUpRawTop1Rate` | 多轮追问**不改写**直接检索的 top1 | 0.5714 |
| `followUpRewrittenTop1Rate` | 改写后 top1 | **1.0** |
| `followUpRewriteTriggered` | 触发改写的次数 | 见实跑输出 |
| `minKeywordScore` | 当次运行实际生效的闸门阈值 | 8.1 |

报告 JSON 除 summary 外还带逐例明细（`id`、`question`、`expectZone`、`top1`、`top1Path`、`hit1`、`hit3`、`gated`、`reason`、`keywordBestScore`）与多轮明细（`rawTop1`/`rwTop1`/`rawHit1`/`rwHit1`/`rwHit3`）——定位"哪条用例退化"靠这个。

**用例集 v2（语料换成公司自有材料后）**：49 条单轮用例（46 条计分）+ 7 条追问，覆盖 5 个展区。
当前 46 条全部 top1 命中、闸门 0 误拦。两处与 v1 的差异要记住：

- `svc-05`（作业报告模板哪里获取）**已删除**：新语料没有"报告模板"这项服务，问题本身不再成立。
- `mix-02`（无人机巡检比人工爬塔更安全吗）的期望从风场侧改到光伏医生侧：新语料把"无人机替代人工登高作业、规避人工巡检安全风险"
  这条论点放在 `02_光伏医生运维系统/巡检与缺陷诊断.md`，风场侧只剩 3 篇薄资料（4 个展区合并时没动它）。

旧实现时代的两条召回天花板（`wind-06`、`svc-05`）随语料更换自然消失，但**不要**因此认为风场展区变强了：
它的 3 篇资料合计约 2 千字，仍是全库最薄的一块。

基线文件：

- `docs/eval/baseline-java.json` —— 当前实现（Spring Boot）的基线，阈值 8.1，可直接 `--baseline=` 对比。
- `docs/eval/baseline.json` —— **历史文件**（23 块语料时代，Node 实现）。语料规模不同，`top1/top3` **不可直接比**，只作为证据留存。
- `docs/eval/retrieval-*.json` —— 历史实跑报告（按时间戳）。

## 4. 标定

```bash
cd server
../tools/mvn -B test-compile exec:java@calibrate                # 阈值标定（默认也写报告）
../tools/mvn -B test-compile exec:java@calibrate -Dexec.args="--grid"          # 加跑打分参数网格
../tools/mvn -B test-compile exec:java@calibrate -Dexec.args="--no-write"      # 只打印
```

四段输出：

1. **在域用例（按关键词分升序，最弱 8 条）**：会被闸门误拦的候选从这儿看，附带 `cos`（向量余弦）与命中词。
2. **域外问题（按分数降序）**：闸门可能放过去乱答的从这儿看。
3. **区间与建议**：`在域最低 X` / `域外最高 Y` / `区间 X~Y` / `建议 minKeywordScore = 中点`；若 `域外最高 / 当前阈值 > 0.9` 会额外告警「闸门偏松」。
4. **打分参数网格**（`--grid`）：`expansionWeight × maxTfBoost × zoneBoost × lengthB`（默认 36 组）按 top1/top3 排序，标出当前默认值与每组漏例。

退出码：区间不成立（域外最高分不低于在域最低分）→ **退出码 2**，可以直接当 CI 的失败条件。
报告写到 `docs/eval/calibration-<时间戳>.json`。

### 当前标定结论（2026-09-22，111 块语料）

| 项 | 值 |
| --- | --- |
| 在域用例最低分（**排序分**，闸门真正比较的那个） | 8.398 |
| 域外问题最高分（排序分） | 6.984 |
| 区间（排序分口径） | 6.984 ~ 8.398（成立） |
| 实际生效阈值 | **8.1**（落在区间内，距下界 1.116；`.env`、`application.yml` 默认值、`HybridRetriever` 默认常量、CI 四处一致） |
| 在域用例最低分（**只算用户原话**，工具默认口径） | 6.043 |
| 域外最高分（只算用户原话） | 6.984 |
| 区间（只算原话口径） | **不成立**（6.043 < 6.984，工具因此打「建议补同义词或换语义向量」并退 2） |

⚠️ **两个口径不一致，别被工具的措辞带跑**：`HybridRetriever` 判闸门用的是 `keywordBestScore`（排序分，含同义词扩展，
代码注释里写了为什么——「检测报告包含哪些内容？」这类问题的原话分只有 2.64，只有扩展词才把它救过阈值）；
而 `Calibrate` 的区间判据与措辞按 `keywordGateScore`（只算原话）算，还自称"与闸门同一口径"。
**按闸门实际口径，区间成立、8.1 站得住；按工具口径，区间不成立。** 两套数字都是实测，先照这个记录用，
改口径要连带改工具、`docs/eval.md` 与 CI 的判据，属于独立的一件事。

参数网格：改语料后没有再跑 `--grid`（打分参数没动）。要动 `ScoringOptions` 再跑，别凭手感调。

阈值演进：`3.8`（23 块语料时代的中点）→ `6.3`（8 篇演示资料入库后）→ `8.1`（修掉跨标点 bigram 与「话题枢纽式同义词」后，域外最高分从 10.96 压到 7.272；评测在 8.1 下闸门漏答为 0）
→ 仍为 `8.1`（语料换成公司自有材料、演示资料全删、134 → 111 块）：新语料更同质，"光伏/组件/清洗"这类词的 IDF 整体下降，
在域问句的关键词分从 8.9+ 掉到 5~7，一度误拦 8 条；**没有调阈值**，而是按 `docs/knowledge.md` §4 的「问句式小节标题」
补了访客原话问句做 `##` 标题，把在域最低分抬回 8.398，误拦归零。
**阈值是相对量**：语料一变，IDF 随之变化、分数整体平移，不重标就可能把该答的问题拦掉。

## 5. 改语料后的标准流程

```bash
# 1) 重载知识并重建索引
curl -X POST http://127.0.0.1:8787/api/knowledge/reload -H "authorization: Bearer $ADMIN_TOKEN"
# 2) 抽查一在域一域外（中文用 Python 发，见 docs/api.md）
#    GET /api/admin/diagnostics?q=…  → 在域应 gated=false；域外应 gated=true 且 distanceToGate>0
# 3) 重新标定，看区间是否还成立
cd server && ../tools/mvn -B test-compile exec:java@calibrate --grid
# 4) 需要改阈值时，四处同步：.env / application.yml / HybridRetriever 默认常量 / CI 环境变量
# 5) 评测确认不退化（top1/top3 不低于基线、gateBlockedCount 仍为 0）
cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write"
# 6) 接口契约冒烟
python tools/smoke.py
```

## 6. CI 里怎么跑

`.github/workflows/ci.yml` 的 backend 作业：`mvn test` → `exec:java@eval --no-write` → `package` → 起 jar 跑 `python3 tools/smoke.py`，并显式给出 `MIN_RELEVANCE_SCORE=8.1`（CI 里没有 `server/.env`，不显式给就会退回代码默认值——"CI 通过"必须验的是线上那套阈值）。

失败该往哪修：

| 失败 | 先看 |
| --- | --- |
| `mvn test` 红 | 单测本身：检索/HTTP/统计/同义词/诊断文案 |
| eval 的 `top1/top3` 下降 | 最近的打分/分块/同义词改动；必要时 `--baseline=` 对比逐例明细找出退化的用例 |
| eval 的 `gateBlockedCount > 0` | 在域问题被闸门拦：跑标定看区间，通常是阈值相对语料变了 |
| 标定退出码 2 | 区间不成立：补同义词、补语料，或换真语义 embedding（`EMBED_PROVIDER=openai_compat`） |
| smoke 红 | 契约被改坏：对照 `docs/api.md` 的字段表 |

## 7. 测试与评测的边界

- **单测**（`mvn test`，33 项）用**合成语料**：闸门行为要可复现，不受展厅资料改动影响；合成语料用**自己的固定阈值**，不跟生产阈值走。
- **评测/标定**用**真实知识库**：目标是线上效果，必须读 `KNOWLEDGE_DIR` 里的真资料。
- 两者都不需要 MySQL；评测与标定会完整启动 Spring 容器（无库时按降级模式运行，`storageAvailable=false`，不影响检索结论）。
