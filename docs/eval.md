# 检索评测报告

> 脚本：`npm run eval:retrieval`（`server/scripts/eval-retrieval.ts`）
> 用例：`server/eval/retrieval-cases.json`（30 条计分 + 2 条开放问）
> 结果落盘：`docs/eval/baseline.json` 与带时间戳的 `retrieval-*.json`

## 如何跑

```bash
npm install
npm run eval:retrieval
```

输出摘要：`top1Rate` / `top3Rate`（**未加闸门**的召回能力）、`gatedTop1Rate` / `gatedTop3Rate` /
`gateBlockedCount`（**生产路径**含相关性闸门后的指标与漏答清单）、`minKeywordScore`。

## 三个指标要分开看

| 指标 | 含义 | 看什么 |
|------|------|--------|
| `top1Rate` / `top3Rate` | 原始融合检索的召回上限 | 换 embedding / 改同义词后的趋势 |
| `gatedTop1Rate` / `gatedTop3Rate` | 叠加相关性闸门（生产实际走这条路） | 闸门是否把该答的问题也拦了 |
| `gateBlockedCount` / `gateBlocked` | 被闸门拦下的**计分用例**（即漏答） | **必须为 0**；非 0 说明阈值过紧或知识缺口 |

## 相关性阈值标定

```bash
npm run calibrate -w server
```

在现有知识库上打印在域用例与 10 条域外闲聊（天气、写诗、会议室…）的关键词分分布，
并给出 `MIN_RELEVANCE_SCORE` 建议值（取两侧区间中点）。**知识库或同义词变更后必须重跑**：
阈值是相对量，chunk 数量一变（分块、增删资料）IDF 就变，分数整体平移。

## Baseline（bag / offline，2026-09-18 第二轮加固后）

| 字段 | 值 |
|------|-----|
| embedProvider / semantic | `bag` / `false`（向量路不参与，检索按 `keyword` 上报） |
| llmProvider | `mock` |
| knowledgeChunks | **23**（标题感知分块；加固前为 8） |
| cases | 30 计分（另 2 条开放问不计分） |
| top1Rate | **0.9667**（29/30） |
| top3Rate | **1.00**（30/30） |
| gatedTop1Rate / gatedTop3Rate | **0.9667 / 1.00** |
| gateBlockedCount | **0**（无漏答） |
| minKeywordScore | 3.8 |

对照：加固前（0.8.0，8 chunks、单字命中参与打分）top1 0.90 / top3 1.00。
提升来自两处：中文分词改为 bigram-only + IDF 加权（单字噪声不再给分）、按 markdown 标题分块。

闸门另一侧的实测（`/api/chat` 直连）：

| 类型 | 样本 | 结果 |
|------|------|------|
| 域内 | 6 条（产品/流程/服务/参观） | 全部 `noHit=false`、给出 sources |
| 域外 | 10 条（今天上海天气 / 写诗 / 会议室 / 股票 …） | 全部 `noHit=true`、`sources=[]`、答「展厅资料中没有这方面的内容」 |

## 接入真实 Embedding / LLM（C1 / C2）

当前仓库代码已支持 `openai_compat`，**无需改业务 API**。在 `server/.env`：

```bash
# C1 语义向量（推荐 bge-small-zh 等中文模型，经内网 OpenAI 兼容网关）
EMBED_PROVIDER=openai_compat
EMBED_BASE_URL=http://<内网网关>/v1
EMBED_API_KEY=<key>
EMBED_MODEL=bge-small-zh

# C2 真实 LLM（Mock 仅作离线兜底）
LLM_PROVIDER=openai_compat
LLM_BASE_URL=http://<内网网关>/v1
LLM_API_KEY=<key>
LLM_MODEL=<模型名>
```

然后：

1. `POST /api/knowledge/reload`（或重启 server）重建向量索引；
2. `npm run eval:retrieval` 与 `npm run calibrate -w server` 各跑一次：语义向量上线后
   `semantic=true`、`retrieval` 变为 `hybrid`，靠关键词兜不住的问法应能被向量路救回
   （`MIN_VECTOR_SCORE` 控制这一路兜底门槛）；
3. 回答不再出现「Mock 演示」类文案即 C2 生效；`health.retrieval.semantic=true` 即 C1 生效。

**本机当前状态**：未配置 `server/.env`，评测在 **bag + 关键词为主** 下完成，作为 baseline。

## 运营接口（Phase C）

- `GET /api/admin/feedback-stats`：负反馈 top 问题（含 `recent` 便于核对正向反馈）
- `GET /api/admin/feedback-stats?format=csv`：导出
- `GET /api/stats`：`noHit` 计数 = 知识库未覆盖次数（下一批要补的资料）
- 展览联动：页面 URL `?zone=pv-clean` 或 `window.znwdSetZone('exhibit-wind-inspect')`
