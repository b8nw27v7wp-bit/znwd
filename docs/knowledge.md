# 企业知识库维护

## 目录结构（展览分区）

知识按**展区/专题**分目录，`_meta/zones.json` 定义分区、别名与推荐问题：

```
knowledge/
  _meta/
    zones.json          # 展区元数据 + 推荐问题 + 媒体映射
  01_研究院概况/
  02_开放平台/
  03_参观指南/
  90_通识/
```

- 跳过 `_meta/` 目录扫描（不进入检索）。
- 每个专题目录下放 `.md` / `.txt`（可用 YAML frontmatter 覆盖 `title` / `zone` / `tags`）。

示例 frontmatter：

```markdown
---
title: 参观接待流程
zone: visit
tags: 预约, 讲解, 开放日
---
```

未写 frontmatter 时：`zone` 由顶层目录名匹配 `zones.json` 的 `dir` 推断。

## zones.json

```json
{
  "zones": [
    { "id": "visit", "dir": "03_参观指南", "title": "参观指南",
      "aliases": ["参观", "预约"], "suggestions": ["…"] }
  ],
  "media": [
    { "mediaId": "exhibit-xxx", "title": "…", "zoneId": "visit" }
  ]
}
```

旁侧展览播放时，前端可调 `GET /api/suggestions?zone=<zoneId|mediaId>` 切换推荐问题。

## Hybrid 检索（当前实现）

问答检索为 **关键词 + 向量** 两路 RRF 融合：

| 路 | 说明 |
|----|------|
| 关键词 | 中文 bigram + 标题/标签/正文加权 |
| 向量 | `EMBED_PROVIDER`：`bag`（离线哈希，默认）或 `openai_compat`（内网 embeddings） |

- 索引文件：`server/indexes/vectors.<provider>.json`（gitignore）。
- `POST /api/knowledge/reload` 会重建两路索引。

### 切换到真实向量（推荐内网）

`server/.env`：

```
EMBED_PROVIDER=openai_compat
EMBED_BASE_URL=https://your-gateway/v1
EMBED_API_KEY=...
EMBED_MODEL=bge-small-zh   # 按网关实际模型名
```

## 更新流程

1. 在对应展区目录增删改 Markdown。  
2. 如需改推荐/分区，改 `_meta/zones.json`。  
3. `POST /api/knowledge/reload`。  
4. `GET /api/knowledge/list` 确认 `chunkCount` 与 `retrieval.vector`。  

## 检索验收口令

| 问题 | 期望 |
|------|------|
| 智慧交通展区展示什么？ | 命中「展览区：智慧交通」 |
| 开放日讲解多久？ | 命中「开放日与讲解」/参观指南 |
| 如何接入开放平台？ | 命中开放平台文档 |

## 与 LLM 关系

命中片段拼进 system 的 `【企业知识】`；无命中为 `（无命中片段）`。详见 [api.md](./api.md)。
