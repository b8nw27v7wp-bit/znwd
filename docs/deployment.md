# 部署与展厅运行

适用：研究院门口触屏一体机 / 横屏大屏浏览器。当前阶段为**内网单机演示**，非公网生产。

## 推荐部署形态

```
一体机（Windows/Linux + Chrome/Edge 全屏）
 ├── 静态前端（web build 产物） 或 开发态 vite preview
 └── 本机/旁路 node 运行 server（Fastify）
          └── 读取 knowledge/ 与 .env
```

优先 **单机双进程**：server 与前端同机，减少现场网络问题。

## 构建

```bash
npm install
npm run build
# 产物：server/dist、web/dist
```

## 运行（生产向）

```bash
# 后端
npm run start
# 等价于 node server/dist/index.js（请在已配置 PORT/.env 的环境下）

# 前端静态资源可用任意静态服务器指向 web/dist
# 注意：静态托管需将 /api 反代到 8787（开发态由 Vite 代理）
```

开发态快捷方式仍是 `dev:server` + `dev:web`。

## 现场检查清单

| 项 | 检查 |
|----|------|
| 电源/网络 | 内网可达 LLM 网关（若非 mock） |
| 浏览器 | 全屏 F11；缩放 100%；系统合成音已启用 |
| 权限 | 屏幕常亮、禁用系统休眠 |
| 知识 | `health.knowledgeChunks` > 0 |
| 麦克风/音箱 | 音量足够；TTS 有中文语音包 |
| 启动脚本 | 服务开机自启（计划任务/服务化可后续加） |
| 恢复 | server 挂掉时 health 失败 → 告警/自动拉起 |

## 安全注意（Phase A）

- `.env` 含 `LLM_API_KEY`，勿提交、勿拷到公开目录。
- **`HOST` 默认 `127.0.0.1`**。跨机访问请：显式设 `HOST=0.0.0.0` 或保持本机监听 + Caddy/nginx 反代，并限制防火墙仅放行展厅 VLAN。
- **生产必须设置 `ADMIN_TOKEN`**，并设 `NODE_ENV=production`（或 `REQUIRE_ADMIN_TOKEN=true`）。未设置时 `/api/stats`、`/api/knowledge/reload` 返回 **401**（开发环境未设 token 仍开放，仅限本机联调）。
- 错误响应脱敏：5xx 仅 `{ error, message: "服务内部错误", requestId }`，堆栈只进服务端日志。
- `KNOWLEDGE_WATCH` 为 experimental（Windows `fs.watch recursive` 不稳定）；生产知识更新用手动 `POST /api/knowledge/reload`（需 Bearer token）。
- JSONL 日志默认 hash 预览 + `LOG_MAX_BYTES` 轮转；勿将 `server/data/` 拷贝到公开位置。
- 局域网演示请确认防火墙仅放行所需端口（默认 8787、5173）。
- 建议部署层：内网 HTTPS（Caddy/nginx）、展厅 VLAN、管理端口不对办公网开放。

### 生产 `.env` 最小安全集

```bash
HOST=127.0.0.1
NODE_ENV=production
ADMIN_TOKEN=<强随机串>
REQUIRE_ADMIN_TOKEN=true
LOG_MESSAGE_MODE=hash
LOG_MAX_BYTES=5000000
```

## Live2D 正式形象

1. 自备 Cubism 模型授权文件 → 放入 `web/public/live2d/`（见该目录 README）。  
2. 按 `Live2DStage.tsx` 注释接入 `pixi.js` + `@pixi-live2d-display`。  
3. 保持 mood 状态机：`idle` / `thinking` / `speaking` 与现有 TTS 联动一致。  

## 故障速查

| 现象 | 处理 |
|------|------|
| 前端能开、提问 500 | 看 server 日志；检查 LLM 配置 |
| 始终 `llm_only` | 关键词无交集；改知识或提问用词；再 reload |
| 无朗读 | 系统语音；页面是否被自动播放策略限制（需用户点过页面） |
| 5173 占用 | 改 `vite.config` 端口，或结束占用进程 |
| 中文 curl 乱码 | 用浏览器或 Node fetch 测试 |
