# Windows 部署脚本（tools/windows）

目标一体机只需要两样东西：**JDK 21+**（`java` 在 PATH，或设置 `JAVA_HOME`）和 **MySQL 8+**（已作为 Windows 服务开机自启）。不需要 Node、Nginx、nssm。仓库里已有的 JDK/MySQL 直接复用。

所有脚本的位置都按自身路径推导仓库根（`%~dp0..\..` / `$PSScriptRoot`），可以整体拷到别的盘符或目录，不用改脚本。

## 脚本一览

| 脚本 | 用途 |
| --- | --- |
| `start-znwd.cmd` | 启动后端起服务（端口 8787），日志追加到 `server\run.out.log`；端口已被监听时拒绝双开 |
| `stop-znwd.cmd` | 找到监听端口的 PID 并 `taskkill /F`；没在跑就提示 |
| `status-znwd.cmd` | 打印端口监听状态、java 进程命令行、`/api/health` 返回 |
| `install-autostart.ps1` | 用计划任务 `znwd-hostess` 配置开机自启/登录自启，支持 `-Remove` 卸载 |
| `deploy-znwd.ps1` | 一体机一键部署：执行 `init.sql` 建库 → 写 `server\.env` → 启动 → 轮询 `/api/health` 验收 →（可选）注册自启 |
| `pack.ps1` | 构建（可跳过）并打包到 `dist\znwd-<日期>\`，同时生成 `DEPLOY.txt` 与同名 zip |

## 常用例子

```bat
rem 启停（都在任意目录双击/执行均可）
tools\windows\start-znwd.cmd
tools\windows\stop-znwd.cmd
tools\windows\status-znwd.cmd

rem 换端口（默认 8787）
tools\windows\start-znwd.cmd --port 8788
set ZNWD_PORT=8788 & tools\windows\stop-znwd.cmd
```

```powershell
# 当前用户登录时自启（不需要管理员）
powershell -ExecutionPolicy Bypass -File tools\windows\install-autostart.ps1

# 系统启动时以 SYSTEM 运行（需要管理员 PowerShell）
powershell -ExecutionPolicy Bypass -File tools\windows\install-autostart.ps1 -AtStartup -Port 8787

# 卸载自启任务
powershell -ExecutionPolicy Bypass -File tools\windows\install-autostart.ps1 -Remove

# 只预览要做什么（WhatIf），不做任何修改
powershell -ExecutionPolicy Bypass -File tools\windows\install-autostart.ps1 -WhatIf

# 一键部署：建库 + 写 .env + 启动 + 健康检查（未给参数则交互输入；-SetAutostart 顺带注册开机自启）
powershell -ExecutionPolicy Bypass -File tools\windows\deploy-znwd.ps1
powershell -ExecutionPolicy Bypass -File tools\windows\deploy-znwd.ps1 -SkipInitDb -NoStart
# 常见参数：-Port 服务端口 / -DbPort 库端口（默认 3306）/ -Embed* 语义检索 / -Audio* 服务端语音
#           -SkipStorageCheck 跳过「storageAvailable 必须为 true」这条判据 / -SkipInitDb / -NoStart / -SetAutostart
# 含双引号的 JSON（LLM_EXTRA_BODY）请用环境变量 ZNWD_LLM_EXTRA_BODY 传：走命令行会被 PowerShell 剥掉引号，
# 写进 .env 就是非法 JSON（MiMo 的思考模式因此关不掉）。一键部署.ps1 已自动改用环境变量。

# 打包（默认先 mvn package + npm ci && npm run build）
powershell -ExecutionPolicy Bypass -File tools\windows\pack.ps1
powershell -ExecutionPolicy Bypass -File tools\windows\pack.ps1 -SkipBuild
```

## 说明

- 端口优先级：`--port N` > 环境变量 `ZNWD_PORT` > 默认 8787。
- 日志按端口分文件：默认端口写 `server\run.out.log`，其它端口写 `server\run-<端口>.out.log`，避免两个实例抢同一个文件句柄。
- 自启任务名固定为 `znwd-hostess`，脚本可重复执行：已有同名任务会先删除再重建。
- `-AtStartup` 以 SYSTEM 运行，只认**机器级** PATH 和 `JAVA_HOME`；脚本会检查并提醒。普通账号的 JDK 装在用户环境里时，请改用默认的 `-AtLogon`。
- 启停/状态脚本必须保存为**纯 ASCII**（注释全英文），`.ps1` 为 ASCII 或带 BOM 的 UTF-8。PowerShell 5.1 会把无 BOM 的非 ASCII 文件按 ANSI 解码，中文注释可能把下一行代码一起毁掉。
- 打包产物保留了仓库目录结构，`tools\windows` 里的脚本在包内可直接使用；`DEPLOY.txt` 是给现场人员的纯 ASCII 操作单。
- `deploy-znwd.ps1` 前置为「环境已装好 + 应用已解压」，它**不安装** JDK/MySQL；执行 init.sql 时用 `MYSQL_PWD` 传 root 口令，不落盘。要覆盖的键写在 `.env` 末尾带标记的托管块，可重复执行（同键以后者为准）。健康检查同时要求 `storageAvailable=true`（不配本机库的演示机可加 `-SkipStorageCheck`）；服务端口不是 8787 时会提示停/查服务要带 `--port`。
