# 演示资料（临时，待替换）

真实知识正文尚未提供，以下文件是**自动抓取的公开网页**，仅用于把
「入库 → 分块 → 检索 → 相关性闸门 → 标定 → 评测」整条链路跑通。
每篇文件的 frontmatter 里带 `source:`（来源 URL）与 `demo: true` 标记；
这些标记不写进正文——正文里的任何一行都会被切块、被检索、被当资料展示在「来源」面板上，
所以来源说明只放 frontmatter 和这张表。**上线前必须删除或替换为公司自有正文。**

| 文件 | 内容 | 来源 |
| --- | --- | --- |
| `01_光伏清洁无人机/demo-pv-dust-cleaning.md` | 光伏组件积灰影响与清洗方式 | solarenpv.com |
| `01_光伏清洁无人机/demo-pv-uav-inspection.md` | 无人机巡检 + 清洁预警 | kingtangdata.com |
| `02_风场检测无人机/demo-wind-blade-inspection.md` | 风机叶片巡检常规方式与实践 | qinghai.gov.cn |
| `02_风场检测无人机/demo-wind-uav-workflow.md` | 风机叶片无人机自动巡检流程 | enterprise.dji.com |
| `02_风场检测无人机/demo-wind-stop-or-not.md` | 停机与不停机检测方案 | cpem.org.cn |
| `02_风场检测无人机/demo-wind-measure-methods.md` | 测风方式对比（雷达/无人机/测风塔） | zoglab.com |
| `02_风场检测无人机/demo-wind-auto-inspection.md` | 风机全自动巡检与缺陷识别 | foiadrone.com |
| `02_风场检测无人机/demo-wind-resource.md` | 地面激光雷达与风资源评估 | mt168.com |

## 删除方式

```bash
rm knowledge/*/demo-*.md                                             # 清掉全部演示资料
cd server && ../tools/mvn -B test-compile exec:java@calibrate        # 删完必须重标阈值（IDF 变了）
cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write"   # 再跑评测，确认数字回到真实知识水平
curl -s -X POST http://127.0.0.1:8787/api/knowledge/reload           # 服务在跑时让索引跟上（或直接重启）
```

## 为什么要重标定

相关性闸门阈值（`MIN_RELEVANCE_SCORE`）是**相对量**：它按关键词 IDF 加权打分，
语料变了 IDF 就变，阈值必须跟着重标。演示资料入库后语料从 8 篇涨到 16 篇（当前 134 块），
阈值不重标会出现「真实问题被闸门拦掉」或「域外问题被放进来」。
