# 代码排查记录（2026-09-17）

范围：`server/` + `web/`，随知识库切换为无人机业务一并处理。

## 已确认并修复

| 级别 | 问题 | 处理 |
|------|------|------|
| 高 | `VectorStore.tryLoad` 仅比对 chunk id，**知识正文变更后仍复用旧向量** | 增加内容指纹 `fingerprint`，不一致则重建索引 |
| 中 | `/api/knowledge/reload` 后 `zones.json` 可能经 hook **异步才生效**，接口短暂旧数据 | suggestions/zones/list 每次请求读盘 |
| 中 | 静音时 `speechSynthesis.cancel()` 可能不触发 `onend`，状态卡在 speaking | `toggleMute` 主动 `setState('idle')` |
| 中 | System/欢迎语仍写「研究院」与旧展区 | 改为无人机展厅话术 |
| 低 | `handleSend` 依赖多余 `messages` | 依赖表已去掉 |
| 低 | 前端 `ChatResponse` 未声明 `retrieval`/`zone` | 类型已补齐 |
| 低 | 向量检索 `score > 0` 过滤导致负相关不进候选（可接受） | 改为全量按分数排序取 top-k，便于融合 |

## 排查后仍接受的设计约束

- `EMBED_PROVIDER=bag` 为离线特征哈希，**不是**语义向量；生产应切 `openai_compat`。  
- 会话/统计/限流均为内存态，进程重启清空。  
- `/api/knowledge/reload`、`/api/stats` 无鉴权，仅适合内网展厅。  
- Mock LLM 文案固定，接入真实 `openai_compat` 后表现取决于模型与知识质量。  

## 建议后续（未阻塞）

1. 前端「重置」时调用 `DELETE /api/sessions/:id` 清服务端会话。  
2. 展览播放进度接入 `?zone=` 切换推荐问题。  
3. 知识条目补充更多真实参数/FAQ；有向量网关后做一次检索评测。  

## 验收命令摘要

```
npm run build -w server
npm run build -w web
# 重启 server 后 curl health / suggestions / chat（光伏、叶片问题）
```
