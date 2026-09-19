# 企业知识库维护

## 业务主题（当前）

- **光伏清洁无人机**（`01_光伏清洁无人机`，zone: `pv-clean`）  
- **风场检测无人机**（`02_风场检测无人机`，zone: `wind-inspect`）  
- 服务合作、展厅须知  

替换正式资料时**保持目录 id 与 zones.json 的 `dir` 一致**即可，无需改代码。

## 目录结构

```
knowledge/
  _meta/zones.json      # 展区、别名、推荐问题、媒体 ID
  01_光伏清洁无人机/*.md
  02_风场检测无人机/*.md
  03_服务与合作/*.md
  90_通识/*.md
```

- `_meta/` 不进入检索。  
- 支持 YAML frontmatter：`title` / `zone` / `tags`。  
- 未写 frontmatter 时，`zone` 由顶层目录名与 `zones.json.dir` 匹配。

## zones.json

```json
{
  "zones": [
    { "id": "pv-clean", "dir": "01_光伏清洁无人机", "title": "光伏清洁无人机",
      "aliases": ["光伏", "清洁"], "suggestions": ["..."] }
  ],
  "media": [
    { "mediaId": "exhibit-pv-clean", "title": "光伏展项", "zoneId": "pv-clean" }
  ]
}
```

旁侧展览播放时：`GET /api/suggestions?zone=pv-clean` 或 `?zone=exhibit-pv-clean`。

## Hybrid 检索

| 路 | 说明 |
|----|------|
| 关键词 | 中文 **bigram**（单字不给分）+ **IDF 加权** + 标题/标签/正文加权 |
| 向量 | `EMBED_PROVIDER=bag`（离线特征哈希，`semantic=false`）或 `openai_compat`（内网 embeddings，`semantic=true`） |
| 融合 | RRF |
| 闸门 | 关键词分 < `MIN_RELEVANCE_SCORE`（且语义向量路不达标）→ 判定「知识库未覆盖」，不拿无关片段硬答 |

- 单字命中不再算命中：此前「今天上海天气怎么样」的关键词分（2.46）会高于若干真实问题，导致什么都能答。
- 索引：`server/indexes/vectors.<provider>.json`（含内容指纹，知识变更自动重建）。
- `retrieval` 与 `health.retrieval.mode` 如实上报：只有语义向量真的参与融合才是 `hybrid`，否则 `keyword`（附 `degradedReason`）。
- `POST /api/knowledge/reload` 重建关键词 + 向量。

### 分块规则

- 以 markdown 标题为硬边界分段，块内携带标题（后续块标「（续）」）避免脱离上下文。
- 段落打包到 500 字上限；单段超长时按 500/80 的窗口+重叠滑窗切分。
- 因此**一篇长文会切成多块**（当前 8 个文件 → 23 块）；块 id 为 `<相对路径>#<序号>`。
- 换行与标题层级都会影响块边界：整理资料时用 `##` 分节，检索精度更好。

### 排序与打分（改语料后要重跑调参）

关键词路打分 = 标题(×2.2) + 展区标签(×1.0) + 正文(×1.0)，词条按 IDF 加权、词频增益封顶，
同义词扩展词按 0.45 降权（扩展是提示不是要求）。默认值集中在
`server/src/knowledge/retriever.ts` 的 `DEFAULT_SCORING`。

```bash
npm run tune:scoring -w server   # 网格搜索，按 top1/top3 + 闸门余量选参数，别手调
```

两条硬规则（都是踩过的坑）：

- **非语义向量不参与排序融合**：`EMBED_PROVIDER=bag` 时向量是哈希兜底、不是相似度，
  只做诊断上报；融合进去会打乱关键词路排序，而 `mode` 仍如实上报 `keyword`——
  上报与行为不一致最难排查。闸门那侧本来就要求 `semantic`，两处保持一致。
- **闸门拦截时不调用大模型**：拒答文案固定（`provider='gate'`，0 token）。
  实测一次拒答约 780 tokens 且要等 4.7 秒，纯浪费；要模型措辞时设 `NO_HIT_LLM=true`。

### 改知识后必做

```bash
curl -X POST http://127.0.0.1:8787/api/knowledge/reload
npm run calibrate -w server      # 重新标定 MIN_RELEVANCE_SCORE
npm run eval:retrieval           # top1/top3 不退化、gateBlockedCount=0
```

阈值是相对量：chunk 数变化会改变 IDF，分数整体平移，**不重标就可能把该答的问题拦掉**。
实测：把 2 篇文档入库后 `knowledgeChunks` 23 → 28、top1 0.9667 → 0.9333（阈值区间未变）。

## 资料入库（PDF / Word / txt）

```bash
# 把资料丢进 ./inbox（或任意目录），指定展区后入库
npm run ingest -w server -- --src ./inbox --zone pv-clean
npm run ingest -w server -- --src ./inbox --zone pv-clean --dry-run   # 只看会写哪些文件
npm run ingest -w server -- --src ./inbox --zone pv-clean --force     # 覆盖同名目标
```

| 输入 | 转换方式 | 说明 |
|------|----------|------|
| `.pdf` | `pdftotext -layout` | 无文字层的扫描件会**明确报错**（提示走 OCR），不会写出空文件 |
| `.docx` | python + python-docx | 保留标题层级、列表与表格（转 markdown 表） |
| `.txt` / `.md` | 直读 | 统一做规范化（去页码/分隔线、合并 PDF 逐行断行、拉丁文补空格） |
| `.doc` | 不支持 | 先用 Word 另存为 `.docx` 或 `.txt`（本机无 libreoffice） |

输出写到 `knowledge/<展区目录>/<文件名>.md`，带 frontmatter：

```markdown
---
title: 光伏清洁作业规范
zone: pv-clean
tags: pv-clean,ingest
source: 光伏清洁作业规范.docx
ingestedAt: 2026-09-19
---
```

入库后按「改知识后必做」走一遍。**整理资料时用 `##` 分节**，分块与检索精度都会更好。

内网真实向量：

```
EMBED_PROVIDER=openai_compat
EMBED_BASE_URL=https://your-gateway/v1
EMBED_API_KEY=...
EMBED_MODEL=bge-small-zh
```

## 更新流程

1. 替换/新增对应展区 Markdown。  
2. 更新 `_meta/zones.json`（如有新展区）。  
3. `POST /api/knowledge/reload`。  
4. `GET /api/knowledge/list` 确认 `chunkCount` 与 `retrieval`（`mode`/`semantic`）。  
5. 跑 `calibrate` + `eval:retrieval`。

## 验收问题示例

| 问题 | 期望 |
|------|------|
| 光伏清洁无人机是做什么的？ | `01_光伏清洁无人机/产品概述` |
| 叶片检测要停机吗？ | `02_风场检测无人机/叶片检测说明` |
| 如何联系合作？ | `03_服务与合作` |
| 今天上海天气怎么样？ | **noHit=true**、无 sources（闸门拦下） |
