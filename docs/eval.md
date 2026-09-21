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
| `top1Rate` | 第一条命中即算命中 | **0.9333**（30 条计分用例中 28 条） |
| `top3Rate` | 前三里有命中 | **0.9667** |
| `gateBlockedCount` | 在域用例被闸门误拦的条数 | **0** |
| `followUpRawTop1Rate` | 多轮追问**不改写**直接检索的 top1 | 0.3333 |
| `followUpRewrittenTop1Rate` | 改写后 top1 | **1.0** |
| `followUpRewriteTriggered` | 触发改写的次数 | 见实跑输出 |
| `minKeywordScore` | 当次运行实际生效的闸门阈值 | 8.1 |

报告 JSON 除 summary 外还带逐例明细（`id`、`question`、`expectZone`、`top1`、`top1Path`、`hit1`、`hit3`、`gated`、`reason`、`keywordBestScore`）与多轮明细（`rawTop1`/`rwTop1`/`rawHit1`/`rwHit1`/`rwHit3`）——定位"哪条用例退化"靠这个。

**当前两条漏例**：`wind-06`、`svc-05`（任何参数组合都进不了 top1）。这是召回天花板，要提升只能补语料或补同义词，调参数无用。

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

### 当前标定结论（2026-09-20，134 块语料）

| 项 | 值 |
| --- | --- |
| 在域用例最低关键词分 | 8.933 |
| 域外问题最高关键词分 | 7.272 |
| 区间 | 7.272 ~ 8.856（成立） |
| 建议阈值 | **8.1**（区间中点） |
| 实际生效阈值 | 8.1（`.env`、`application.yml` 默认值、`HybridRetriever` 默认常量、CI 四处一致） |
| 参数网格 | 36 组**没有一组超过当前默认值**（top1 0.9333 / top3 0.9667），默认参数保持不动 |

阈值演进：`3.8`（23 块语料时代的中点）→ `6.3`（8 篇演示资料入库后）→ `8.1`（修掉跨标点 bigram 与「话题枢纽式同义词」后，域外最高分从 10.96 压到 7.272；评测在 8.1 下闸门漏答为 0）。
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
