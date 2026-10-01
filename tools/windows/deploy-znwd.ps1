<#
.SYNOPSIS
    znwd 一体机一键部署脚本（Windows / PowerShell 5.1+）。

.DESCRIPTION
    前置条件：已装好 JDK 21+ 与 MySQL 8+（并设为 Windows 服务），应用包已解压。
    本脚本自动完成：
      1) 用 MySQL 管理员账号执行 server\db\init.sql（建库 znwd + 最小权限账号 znwd@localhost）
      2) 生成/更新 server\.env（DB_* / ADMIN_TOKEN / LLM_* / EMBED_* / AUDIO_*）
      3) 启动服务并轮询 /api/health 做验收
      4) 可选：注册开机自启
    本脚本不安装 JDK / MySQL —— 那一步请先用环境安装包手工装好。

.PARAMETER AppDir
    解压后的应用包根目录（应含 server\target\hostess-server.jar）。
    缺省时从脚本所在目录向上自动查找。

.PARAMETER DbPassword
    要为 znwd 数据库账号设置的口令（同时写进 init.sql 与 server\.env）。缺省时交互输入。

.PARAMETER RootUser / RootPassword
    MySQL 管理员账号 / 口令，用于执行 init.sql。RootPassword 缺省时交互输入（不回显）。

.PARAMETER MysqlExe
    mysql.exe 完整路径。缺省自动在常见位置查找。

.PARAMETER AdminToken
    管理接口口令。缺省自动生成 32 位随机串。

.PARAMETER Port
    服务端口，默认 8787。

.PARAMETER SkipInitDb
    跳过执行 init.sql（库已经建过时用）。

.PARAMETER NoStart
    只写配置、不启动服务。

.PARAMETER SetAutostart
    额外注册开机自启（需要管理员 PowerShell）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy-znwd.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File deploy-znwd.ps1 -DbPassword "P@ss" -RootPassword "rootPwd" `
      -LlmBaseUrl "https://api.xiaomimimo.com/v1" -LlmApiKey "sk-xxx" -LlmModel "mimo-v2.5" `
      -LlmExtraBody '{"thinking":{"type":"disabled"}}' -SetAutostart
#>
[CmdletBinding()]
param(
    [string]$AppDir,
    [string]$DbPassword,
    [string]$RootUser = 'root',
    [string]$RootPassword,
    [string]$MysqlExe,
    [string]$AdminToken,
    [string]$LlmProvider,
    [string]$LlmBaseUrl,
    [string]$LlmApiKey,
    [string]$LlmModel,
    [string]$LlmExtraBody,
    [string]$EmbedProvider,
    [string]$EmbedBaseUrl,
    [string]$EmbedApiKey,
    [string]$EmbedModel,
    [string]$AudioProvider,
    [int]$Port = 8787,
    [switch]$SkipInitDb,
    [switch]$NoStart,
    [switch]$SetAutostart,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "[FAIL] $m" -ForegroundColor Red; exit 1 }

function New-RandomToken([int]$len = 32) {
    $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    $bytes = New-Object byte[] $len
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $sb = New-Object System.Text.StringBuilder
    foreach ($b in $bytes) { [void]$sb.Append($chars[$b % $chars.Length]) }
    return $sb.ToString()
}

function Read-Secret([string]$prompt) {
    $sec = Read-Host -Prompt $prompt -AsSecureString
    return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR(
        [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}

function Find-AppRoot([string]$start) {
    $dir = [System.IO.Path]::GetFullPath($start)
    for ($i = 0; $i -le 4 -and $dir; $i++) {
        if (Test-Path -LiteralPath (Join-Path $dir 'server\target\hostess-server.jar')) { return $dir }
        $parent = Split-Path -Parent $dir
        if ($parent -eq $dir) { break }
        $dir = $parent
    }
    return $null
}

function Find-MysqlExe {
    $patterns = @(
        (Join-Path $env:ProgramFiles 'MySQL\MySQL Server *\bin\mysql.exe'),
        (Join-Path $env:ProgramW6432 'MySQL\MySQL Server *\bin\mysql.exe'),
        'D:\MySQL\MySQL Server *\bin\mysql.exe',
        'E:\MySQL\MySQL Server *\bin\mysql.exe',
        'C:\MySQL\*\bin\mysql.exe'
    )
    $found = @()
    foreach ($p in $patterns) {
        if ($p -and ($p -notmatch '^\\')) {
            $found += Get-ChildItem -Path $p -ErrorAction SilentlyContinue
        }
    }
    $found = $found | Sort-Object FullName -Descending
    if ($found.Count -gt 0) { return $found[0].FullName }
    $cmd = Get-Command mysql.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

Write-Host ''
Write-Host '=============================================' -ForegroundColor White
Write-Host ' znwd 一体机一键部署' -ForegroundColor White
Write-Host '=============================================' -ForegroundColor White
Write-Host ''

# ---- 0. 定位应用包根 ----------------------------------------------------
if ($AppDir) {
    $AppDir = [System.IO.Path]::GetFullPath($AppDir)
} else {
    foreach ($c in @($PSScriptRoot, (Get-Location).Path)) {
        if ($c) { $r = Find-AppRoot $c; if ($r) { $AppDir = $r; break } }
    }
}
if (-not $AppDir -or -not (Test-Path -LiteralPath (Join-Path $AppDir 'server\target\hostess-server.jar'))) {
    Die "找不到应用包根（需包含 server\target\hostess-server.jar）。请用 -AppDir 指定解压后的目录。"
}
$serverDir = Join-Path $AppDir 'server'
Info "应用目录 : $AppDir"

# ---- 1. 检查 java -------------------------------------------------------
$javaCmd = $null
if (Get-Command java -ErrorAction SilentlyContinue) { $javaCmd = 'java' }
elseif ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    $javaCmd = Join-Path $env:JAVA_HOME 'bin\java.exe'
}
if (-not $javaCmd) { Die "未找到 java。请先安装 JDK 21+ 并配好 PATH 或 JAVA_HOME。" }
$verText = (& $javaCmd -version 2>&1 | Out-String)
$major = 0
if ($verText -match 'version "(\d+)(?:\.(\d+))?') {
    $major = [int]$Matches[1]
    if ($major -eq 1 -and $Matches[2]) { $major = [int]$Matches[2] }
}
if ($major -lt 21) { Die "检测到 Java 主版本 $major，要求 21+。请安装 JDK 21+。" }
Ok "Java 主版本 $major"

# ---- 2. 交互补齐参数 ----------------------------------------------------
if (-not $DbPassword) {
    if ($NonInteractive) { Die '非交互模式必须提供 -DbPassword。' }
    $DbPassword = Read-Secret '请设置 znwd 数据库口令'
}
if (-not $DbPassword) { Die '数据库口令不能为空。' }

if (-not $AdminToken) {
    $AdminToken = New-RandomToken 32
    Info "已自动生成 ADMIN_TOKEN: $AdminToken"
    Warn '请把该口令记下来（运营视图 / 管理接口需要）。'
}

# 若未给 LLM，询问是否现在配置真实模型
if (-not $LlmBaseUrl -and -not $LlmModel -and -not $NonInteractive) {
    $ans = Read-Host '未提供 LLM 配置。现在配置真实模型吗？(Y 配置 / 直接回车=稍后手改 server\.env)'
    if ($ans -match '^[Yy]') {
        if (-not $LlmProvider) { $LlmProvider = 'openai_compat' }
        if (-not $LlmBaseUrl) { $LlmBaseUrl = Read-Host 'LLM_BASE_URL（如 https://api.xiaomimimo.com/v1）' }
        if (-not $LlmApiKey)  { $LlmApiKey  = Read-Host 'LLM_API_KEY' }
        if (-not $LlmModel)   { $LlmModel   = Read-Host 'LLM_MODEL（如 mimo-v2.5）' }
        if (-not $LlmExtraBody) {
            $eb = Read-Host 'LLM_EXTRA_BODY（MiMo 需 {"thinking":{"type":"disabled"}}，可回车跳过）'
            if ($eb) { $LlmExtraBody = $eb }
        }
    }
}
if ($LlmBaseUrl -or $LlmModel) {
    if (-not $LlmProvider) { $LlmProvider = 'openai_compat' }
    if (-not $LlmBaseUrl -or -not $LlmModel) {
        Warn 'LLM 只填了一部分（BASE_URL / MODEL 需同时提供），否则真实回答会失败。'
    }
} else {
    Warn '未配置真实 LLM：服务会以 mock 运行（页面正常，但回答是演示摘要）。稍后手改 server\.env 后重启即可。'
}

# ---- 3. 执行 init.sql 建库 ---------------------------------------------
if (-not $SkipInitDb) {
    if (-not $MysqlExe) { $MysqlExe = Find-MysqlExe }
    if (-not $MysqlExe) { Die '找不到 mysql.exe。请用 -MysqlExe 指定完整路径。' }
    Info "使用 mysql 客户端: $MysqlExe"

    $initSqlPath = Join-Path $AppDir 'server\db\init.sql'
    if (-not (Test-Path -LiteralPath $initSqlPath)) { Die "缺少 $initSqlPath" }

    $sqlText = [System.IO.File]::ReadAllText($initSqlPath, [System.Text.Encoding]::UTF8)
    $sqlText = $sqlText.Replace('CHANGE_ME_znwd', $DbPassword)

    if (-not $RootPassword) {
        if ($NonInteractive) { Die '非交互模式执行 init.sql 必须提供 -RootPassword。' }
        $RootPassword = Read-Secret "MySQL $RootUser 口令（用于执行 init.sql）"
    }

    $tmpSql = Join-Path ([System.IO.Path]::GetTempPath()) ("znwd-init-" + [Guid]::NewGuid().ToString('N') + '.sql')
    [System.IO.File]::WriteAllText($tmpSql, $sqlText, (New-Object System.Text.UTF8Encoding($false)))

    $oldPwd = $env:MYSQL_PWD
    $env:MYSQL_PWD = $RootPassword
    try {
        Info '正在执行 init.sql（建库 + 建账号）...'
        Get-Content -Raw -LiteralPath $tmpSql | & $MysqlExe --protocol=TCP -h 127.0.0.1 -P 3306 -u $RootUser --default-character-set=utf8mb4
        if ($LASTEXITCODE -ne 0) { Die "init.sql 执行失败（退出码 $LASTEXITCODE）。请检查 root 账号/口令与 MySQL 是否在跑。" }
        Ok '建库完成（库 znwd + 账号 znwd@localhost）'
    } finally {
        if ($null -eq $oldPwd) { Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue } else { $env:MYSQL_PWD = $oldPwd }
        Remove-Item -LiteralPath $tmpSql -ErrorAction SilentlyContinue
    }
} else {
    Info '按要求跳过 init.sql'
}

# ---- 4. 写 server\.env --------------------------------------------------
$envPath = Join-Path $serverDir '.env'
$envExample = Join-Path $serverDir '.env.example'
if (-not (Test-Path -LiteralPath $envPath)) {
    if (-not (Test-Path -LiteralPath $envExample)) { Die "缺少 .env.example：$envExample" }
    Copy-Item -LiteralPath $envExample -Destination $envPath
    Info '已由 .env.example 创建 server\.env'
}

$begin = '# >>> znwd deploy (managed) >>>'
$end   = '# <<< znwd deploy (managed) <<<'
$content = [System.IO.File]::ReadAllText($envPath, [System.Text.Encoding]::UTF8)
$blockPattern = [regex]::Escape($begin) + '.*?' + [regex]::Escape($end) + '(\r?\n)?'
$content = [regex]::Replace($content, $blockPattern, '', [System.Text.RegularExpressions.RegexOptions]::Singleline)
$content = $content.TrimEnd()

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add($begin)
$lines.Add("# 由 deploy-znwd.ps1 写入于 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
$lines.Add('DB_HOST=127.0.0.1')
$lines.Add('DB_PORT=3306')
$lines.Add('DB_NAME=znwd')
$lines.Add('DB_USER=znwd')
$lines.Add("DB_PASSWORD=$DbPassword")
$lines.Add('HOST=127.0.0.1')
$lines.Add("PORT=$Port")
$lines.Add("ADMIN_TOKEN=$AdminToken")
if ($LlmProvider)   { $lines.Add("LLM_PROVIDER=$LlmProvider") }
if ($LlmBaseUrl)    { $lines.Add("LLM_BASE_URL=$LlmBaseUrl") }
if ($LlmApiKey)     { $lines.Add("LLM_API_KEY=$LlmApiKey") }
if ($LlmModel)      { $lines.Add("LLM_MODEL=$LlmModel") }
if ($LlmExtraBody)  { $lines.Add("LLM_EXTRA_BODY=$LlmExtraBody") }
if ($EmbedProvider) { $lines.Add("EMBED_PROVIDER=$EmbedProvider") }
if ($EmbedBaseUrl)  { $lines.Add("EMBED_BASE_URL=$EmbedBaseUrl") }
if ($EmbedApiKey)   { $lines.Add("EMBED_API_KEY=$EmbedApiKey") }
if ($EmbedModel)    { $lines.Add("EMBED_MODEL=$EmbedModel") }
if ($AudioProvider) { $lines.Add("AUDIO_PROVIDER=$AudioProvider") }
$lines.Add($end)

$newContent = $content + "`r`n`r`n" + ($lines -join "`r`n") + "`r`n"
[System.IO.File]::WriteAllText($envPath, $newContent, (New-Object System.Text.UTF8Encoding($false)))
Ok "已写入配置: $envPath"

# ---- 5. 启动 + 验收 -----------------------------------------------------
if ($NoStart) {
    Info '按要求只写配置、不启动（-NoStart）。'
} else {
    $startCmd = Join-Path $AppDir 'tools\windows\start-znwd.cmd'
    if (-not (Test-Path -LiteralPath $startCmd)) { Die "缺少启动脚本: $startCmd" }
    Info "启动服务（端口 $Port）..."
    & $startCmd --port $Port

    Info '等待健康检查（最多 120 秒）...'
    $health = $null
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        try {
            $raw = & curl.exe -s --max-time 5 "http://127.0.0.1:$Port/api/health" 2>$null
            if ($raw) {
                $j = $raw | ConvertFrom-Json
                if ($j.ok -and $j.ready) { $health = $j; break }
            }
        } catch { }
    }
    if ($health) {
        Ok '健康检查通过：'
        Write-Host ("      ok={0}  ready={1}  storageAvailable={2}  knowledgeChunks={3}" -f `
            $health.ok, $health.ready, $health.storageAvailable, $health.knowledgeChunks)
        if ($health.storageAvailable -ne $true) {
            Warn 'storageAvailable != true：数据库未连通。检查 .env 的 DB_PASSWORD 与 MySQL 服务。'
        }
        if (-not $health.knowledgeChunks -or $health.knowledgeChunks -le 0) {
            Warn 'knowledgeChunks <= 0：知识库为空，检查 knowledge\ 目录。'
        }
    } else {
        Warn '120 秒内未通过健康检查。查看日志 server\run.out.log，或运行 status-znwd.cmd 排查。'
    }
}

# ---- 6. 可选：开机自启 --------------------------------------------------
if ($SetAutostart) {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) { Warn '注册开机自启需要管理员权限，请在管理员 PowerShell 里重跑 -SetAutostart。' }
    else {
        $auto = Join-Path $AppDir 'tools\windows\install-autostart.ps1'
        if (Test-Path -LiteralPath $auto) {
            Info '注册开机自启...'
            & powershell -NoProfile -ExecutionPolicy Bypass -File $auto -AtStartup -Port $Port
            Ok '已注册开机自启（计划任务 znwd-hostess）'
        } else { Warn "未找到自启脚本: $auto" }
    }
}

# ---- 7. 收尾 -----------------------------------------------------------
Write-Host ''
Write-Host '=============================================' -ForegroundColor White
Write-Host ' 部署完成' -ForegroundColor Green
Write-Host '=============================================' -ForegroundColor White
Write-Host ("  访问地址 : http://127.0.0.1:{0}/" -f $Port)
Write-Host ("  运营视图 : http://127.0.0.1:{0}/?admin=1" -f $Port)
Write-Host ("  健康检查 : curl.exe -s http://127.0.0.1:{0}/api/health" -f $Port)
Write-Host ("  ADMIN_TOKEN: {0}" -f $AdminToken)
Write-Host '  启停/状态: tools\windows\start-znwd.cmd / stop-znwd.cmd / status-znwd.cmd'
Write-Host ''
