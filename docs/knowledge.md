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
| 关键词 | 中文 bigram + 标题/标签/正文加权 |
| 向量 | `EMBED_PROVIDER=bag`（离线）或 `openai_compat`（内网 embeddings） |
| 融合 | RRF |

- 索引：`server/indexes/vectors.<provider>.json`（含内容指纹，知识变更自动重建）。  
- `POST /api/knowledge/reload` 重建关键词 + 向量。

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
4. `GET /api/knowledge/list` 确认 `chunkCount` 与 `retrieval.vector`。  

## 验收问题示例

| 问题 | 期望 |
|------|------|
| 光伏清洁无人机是做什么的？ | `01_光伏清洁无人机/产品概述` |
| 叶片检测要停机吗？ | `02_风场检测无人机/叶片检测说明` |
| 如何联系合作？ | `03_服务与合作` |
