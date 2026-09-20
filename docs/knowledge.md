# 知识库维护

展厅讲解的知识全部来自 `knowledge/` 目录：改这里的内容 → reload → 抽查 → 重新标定 → 跑评测，是全套流程。

## 1. 目录与展区

```
knowledge/
├── _meta/
│   ├── zones.json          展区、别名、推荐问题、媒体映射（不进入检索）
│   ├── synonyms.tsv        同义词覆盖表（可选；不进入检索）
│   └── demo-docs.md        占位演示文档（不进入检索）
├── 01_光伏清洁无人机/       zone = pv-clean
├── 02_风场检测无人机/       zone = wind-inspect
├── 03_服务与合作/           zone = service
└── 90_通识/                 zone = safety（展厅须知）
```

当前 4 个展区、2 个展项（`media`）：

| zone id | 目录 | 展区名 | 别名（关键词也按这些加权） | 推荐问题 |
| --- | --- | --- | --- | --- |
| `pv-clean` | `01_光伏清洁无人机` | 光伏清洁无人机 | 光伏 / 清洁 / 清洗 / 组件 / 电站 | 3 条 |
| `wind-inspect` | `02_风场检测无人机` | 风场检测无人机 | 风场 / 风电 / 叶片 / 检测 / 巡检 | 3 条 |
| `service` | `03_服务与合作` | 服务与合作 | 服务 / 培训 / 合作 / 售后 / 联系 | 2 条 |
| `safety` | `90_通识` | 展厅须知 | 安全 / 须知 / 参观 / 拍照 | 1 条 |

媒体映射：`exhibit-pv-clean` → `pv-clean`、`exhibit-wind-inspect` → `wind-inspect`。

替换正式资料时**保持目录 id 与 `zones.json` 的 `dir` 一致**即可，不用改代码。

## 2. 文件格式

Markdown，可选 YAML frontmatter：

```markdown
---
title: 光伏清洁无人机产品概述
zone: pv-clean
tags: pv-clean,光伏,清洁
---

## 产品定位

……
```

| 字段 | 作用 |
| --- | --- |
| `title` | 块标题（缺省时用文档内第一个 `#` 标题或文件名） |
| `zone` | 显式指定展区；**不写时按顶层目录名匹配 `zones.json` 的 `dir` 自动推断** |
| `tags` | 逗号/空格分隔，命中时参与打分（权重同展区名） |

其它 frontmatter 键（如 `source`、`ingestedAt`）会被忽略但无害。
`_meta/` 下的文件**不进入检索**（展会元数据与占位文档都在这里）。

## 3. zones.json

```json
{
  "zones": [
    { "id": "pv-clean", "dir": "01_光伏清洁无人机", "title": "光伏清洁无人机",
      "aliases": ["光伏", "清洁", "清洗", "组件", "电站"],
      "suggestions": ["光伏清洁无人机是做什么的？", "清洁作业流程是怎样的？"] }
  ],
  "media": [{ "mediaId": "exhibit-pv-clean", "title": "光伏清洁无人机展项", "zoneId": "pv-clean" }]
}
```

- `aliases` 参与关键词打分（命中展区名的块加权），也是 `/api/suggestions` 匹配用的键之一。
- `/api/suggestions?zone=<zoneId 或 mediaId>`：先按 `mediaId` 映射到所属展区，再按 zoneId / 目录名 / 别名匹配；不传 zone 返回全馆汇总。**返回的 `items` 是字符串数组**。
- 文件缺失或损坏时退化为空展区（不阻塞启动），`/api/zones` 会返回空列表。

## 4. 分块规则

| 规则 | 值 |
| --- | --- |
| 硬边界 | 以 Markdown 标题（`#`~`######`）分段 |
| 段内打包 | 段落合并到 **500 字符**上限 |
| 超长段落 | 按 **500 字窗口 / 80 字重叠**滑窗切分 |
| 块标题 | 每块带所在标题；同一标题的后续块标「标题（续）」+ 正文，避免脱离上下文后语义漂移 |
| 块 id | `<相对路径>#<序号>` |

**一篇长文会被切成多块**（当前 134 块）——这是为什么来源列表里可能看到同一文档的多条：每一块算一条来源（与旧实现一致）。
写作时**用 `##` 分节**、每节一个主题，检索精度会明显更好；把整篇写成一个超长段落反而会被滑窗切碎。

## 5. 检索与打分

```
问题 ──▶ 关键词路（中文 bigram + IDF + 加权，同义词扩展）
      └─▶ 向量路（bag 特征哈希 / openai_compat 真语义）
                └─▶ RRF 融合 ──▶ 相关性闸门 ──▶ 命中 or 「资料中没有」
```

| 项 | 当前值 |
| --- | --- |
| 关键词打分 | 标题 ×2.2 + 展区标签 ×1.0 + 正文 ×1.0（`ScoringOptions`） |
| 词条权重 | IDF 加权；词频增益封顶（长文档靠反复出现泛词取胜是噪声） |
| 中文切分 | **bigram**（单字不给分：否则「今天上海天气怎么样」会比很多真问题分还高，什么都能答） |
| 同义词扩展 | 扩展词按 **0.45** 降权（扩展是提示不是要求），原查询词权重 1 |
| 向量路 | `EMBED_PROVIDER=bag`（特征哈希，`semantic=false`，不参与融合）或 `openai_compat`（真语义，参与 RRF） |
| 融合 | RRF（两路都命中时有微小加成） |
| 闸门 | 关键词最高分 < `MIN_RELEVANCE_SCORE`（当前 **6.3**）且语义向量不达标 → `noHit=true` |

两条硬规则（都是踩过的坑）：

- **非语义向量不参与排序融合**：`bag` 是哈希兜底、不是相似度，融进去只会打乱关键词路排序，而 `mode` 仍如实上报 `keyword`——上报与行为不一致最难排查。
- **闸门拦截时不调用大模型**：拒答文案固定（`provider=gate`、0 token）。实测让模型生成拒答要 780 tokens 且多等 4.7 秒，纯浪费；要模型措辞时设 `NO_HIT_LLM=true`。

排查某句话为什么被拦，直接问诊断接口（走线上同一套阈值）：

```bash
python -c "import json,urllib.parse,urllib.request as u; q=urllib.parse.quote('帮我写一首关于夏天的诗'); d=json.load(u.urlopen('http://127.0.0.1:8787/api/admin/diagnostics?q='+q)); print(d['verdict'], '| 距阈值', d['distanceToGate'])"
```

（中文用 Python 发：GBK 控制台下 curl 会把参数编坏，表现为"什么都被拦"。）

## 6. 同义词维护

内置 23 组（`Synonyms.java`，含「叶片/风叶/桨叶」「巡检/检查/缺陷/裂纹」等），可用外部覆盖表替换或在线维护——**改完对下一个问题立即生效，不需要重建索引**。

1. **覆盖表文件**：`knowledge/_meta/synonyms.tsv`

   ```text
   # 主词<TAB>备选词（逗号分隔），一行一条
   叶片	风叶,桨叶
   塔筒	塔架,风机塔
   ```

2. **在线接口**：

   ```bash
   # 看当前生效的表（含来源：builtin 或文件路径）
   curl -s http://127.0.0.1:8787/api/admin/synonyms -H "authorization: Bearer $ADMIN_TOKEN"

   # 整表替换（persist=true 写回 synonyms.tsv；false 只改内存）
   curl -X PUT http://127.0.0.1:8787/api/admin/synonyms \
     -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
     -d '{"entries":{"叶片":["叶片","风叶","桨叶"],"塔筒":["塔筒","塔架"]},"persist":true}'
   ```

规则与坑：

- 覆盖表存在就加载；**文件被删掉后 `POST /api/knowledge/reload` 会退回内置表**（避免"文件删了还生效"）。
- 表不能为空（空表会被拒），否则等于把检索能力悄悄砍掉一半。
- 覆盖表损坏不会把服务带下去：保留当前生效的表并在日志报错，等人来修。
- 改完同义词要**重跑标定与评测**——扩展词会改变分数分布。

## 7. 改知识后的必做流程

```bash
# 1) 写/替换 knowledge/<展区目录>/*.md（frontmatter + 用 ## 分节）
# 2) 重载（重建关键词 + 向量索引，清空答案缓存）
curl -X POST http://127.0.0.1:8787/api/knowledge/reload -H "authorization: Bearer $ADMIN_TOKEN"
# 3) 核对装载结果
curl -s http://127.0.0.1:8787/api/knowledge/list        # chunkCount、retrieval.mode、各文件块数
# 4) 抽查一在域一域外：在域应 gated=false，域外应 gated=true 且 distanceToGate>0
# 5) 重新标定（阈值是相对量：chunk 数一变，IDF 跟着变、分数整体平移，不重标就可能把该答的问题拦掉）
cd server && ../tools/mvn -B test-compile exec:java@calibrate
# 6) 阈值要改就四处同步：.env / application.yml 默认值 / HybridRetriever 默认常量 / CI 环境变量
# 7) 评测确认不退化
cd server && ../tools/mvn -B test-compile exec:java@eval -Dexec.args="--no-write"
# 8) 契约冒烟
python tools/smoke.py
```

## 8. 资料入库（PDF / Word / txt）

**新栈尚未移植入库工具**：旧 Node 版有 `npm run ingest`（`pdftotext -layout` 转 PDF、python-docx 保留标题层级与表格、统一规范化去页码/合并断行），Java 侧目前没有对应实现，仓库里也没有 `inbox/` 目录。这条挂在 `docs/optimization-backlog.md` 的待做清单里。

当前可行做法：**用外部工具转成 Markdown，再按展区目录落盘**：

```bash
# PDF（需系统有 poppler）
pdftotext -layout 资料.pdf 资料.txt
# Word：用 Word 另存为 .docx 后，用 pandoc 或 python-docx 转 md
pandoc -t gfm --extract-media=. 资料.docx -o 资料.md
```

落盘后自检清单：

1. **标题层级**：主题用 `##`；确认转换没有把标题降级成加粗文本（那会导致整篇被当成一个大段落滑窗切碎）。
2. **去掉噪声**：页眉页脚、页码、PDF 断行造成的碎行、分隔线；英文/数字之间补空格。
3. **表格**：转成 Markdown 表格（纯文本列的表格会被当正文，检索仍能命中，但人看着差）。
4. **编码**：UTF-8；中文文件名可用，但**块 id 含相对路径**，避免在文件名里放空格与特殊符号。
5. **frontmatter**：补 `title` / `zone` / `tags`（`zone` 不写就靠目录名推断，目录名必须与 `zones.json` 的 `dir` 一致）。
6. **扫描件**：没有文字层的 PDF 转换会得到空文件——先 OCR（见技能 `ocr-and-documents`）。

入库后按第 7 节的流程走一遍，别跳过标定与评测。

## 9. 验收问题示例

取自 `server/eval/retrieval-cases.json`，可作为补资料后的手工抽查：

| 问题 | 期望 |
| --- | --- |
| 光伏清洁无人机是做什么的？ | 命中 `01_光伏清洁无人机/产品概述.md`，`noHit=false`、有 sources |
| 清洁作业流程是怎样的？ | 命中 `01_光伏清洁无人机/清洁流程与作业.md` |
| 叶片检测要停机吗？ | 命中 `02_风场检测无人机/叶片检测说明.md` |
| 巡检无人机一次能覆盖多大范围？ | 命中 `02_风场检测无人机/*` |
| 如何联系合作？ | 命中 `03_服务与合作/*` |
| 参观有什么注意事项？ | 命中 `90_通识/展厅参观须知.md` |
| 帮我写一首关于夏天的诗 | **`noHit=true`、`sources=[]`、`provider=gate`**（闸门拦下） |
| 今天上海天气怎么样？ | 同上（域外问题不该硬答） |

验证命令：`curl -s -X POST http://127.0.0.1:8787/api/chat -H "content-type: application/json" -d '{"message":"叶片检测要停机吗？"}'`（中文没问题，因为是 JSON body 而不是 query）。
