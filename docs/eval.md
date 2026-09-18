# 检索评测报告

> 脚本：`npm run eval:retrieval`  
> 用例：`server/eval/retrieval-cases.json`（约 30 条，开放问不计入命中率）  
> 结果落盘：`docs/eval/baseline.json` 与带时间戳的 `retrieval-*.json`

## 如何跑

```bash
# 需先 npm install；可选 server/.env 配置 EMBED_PROVIDER / LLM_PROVIDER
npm run eval:retrieval
```

输出控制台摘要：`top1Rate` / `top3Rate`、embed/llm provider、knowledgeChunks、generation。

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
2. 再跑 `npm run eval:retrieval`，对比 `docs/eval/baseline.json`；  
3. 回答不再出现「Mock 演示」类文案即 C2 生效；health 中 `embedding` 非 `bag` 即 C1 生效。

**本机当前状态**：未配置 `server/.env`，评测在 **bag + 可离线检索** 下完成，作为 baseline。

## Baseline（bag / offline）

| 字段 | 值 |
|------|-----|
| 时间 | 2026-09-18（C4 同义词迭代后） |
| embedProvider | `bag` |
| llmProvider | `mock` |
| cases | 30（另 2 条开放问不计分） |
| top1Rate | **0.90**（27/30） |
| top3Rate | **1.00**（30/30） |

明细：`docs/eval/baseline.json`。首轮 top3 为 0.9333；扩展「作业/模板/触摸/展品」等同义词后 top3=1.0。top1 仍有 3 条偏展区/流程文档，接真实语义向量（C1）后预期改善。

| 指标 | 含义 |
|------|------|
| `top1Rate` | top1 命中期望 zone/sourcePath 比例 |
| `top3Rate` | top3 命中比例 |
| `embedProvider` | `bag` 或 `openai_compat` |

同义词（C4）与 cache generation（K3）变更后应重跑本评测，防止相对 baseline 退化。

## 运营接口（Phase C）

- `GET /api/admin/feedback-stats`（需管理口令策略）：负反馈 top 问题  
- `GET /api/admin/feedback-stats?format=csv`：导出  
- 展览联动：页面 URL `?zone=pv-clean` 或 `window.znwdSetZone('exhibit-wind-inspect')`
