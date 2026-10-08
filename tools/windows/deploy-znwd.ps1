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
    服务端口，默认 8787。不是 8787 时，停/查服务必须带 --port（脚本会提示）。

.PARAMETER DbPort
    MySQL 端口，默认 3306。目标机上已有别的 MySQL 实例（不在 3306）时必须显式指定，
    否则 init.sql 连不上、应用也会按错误端口连库。

.PARAMETER EmbedProvider / EmbedBaseUrl / EmbedApiKey / EmbedModel / EmbedDims
    语义检索（向量召回）。EMBED_PROVIDER=openai_compat 且给了 EmbedApiKey 才算真打开；
    不配就是 EMBED_PROVIDER=bag：只按关键词检索（闸门与排序照常，语义兜底关闭）。
    EmbedDims 缺省 0 = 不写进 .env，由首次响应推断维度（bge-m3 = 1024）。

.PARAMETER AudioProvider / AudioVoice / AudioBaseUrl / AudioApiKey
    服务端语音（TTS/ASR）。AUDIO_PROVIDER=mimo 时打开；AudioBaseUrl/AudioApiKey 留空
    即复用 LLM_*（MiMo 的语音与对话同网关同 key）。AudioVoice 缺省「冰糖」。

.PARAMETER LlmExtraBody / ZNWD_LLM_EXTRA_BODY
    JSON 片段（MiMo 需要 {"thinking":{"type":"disabled"}}）。注意：从命令行传含双引号的 JSON 会被
    PowerShell 剥掉引号，写进 .env 就成了非法 JSON。请用环境变量 ZNWD_LLM_EXTRA_BODY 传，
    或部署后手改 server\.env。（一键部署.ps1 已自动改用环境变量；MiMo 网关还会自动填好。）

.PARAMETER SkipStorageCheck
    跳过「storageAvailable 必须为 true」这条上线判据（只在刻意不配本机 MySQL 的演示机上用）。

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
    [string]$AudioVoice,
    [string]$AudioBaseUrl,
    [string]$AudioApiKey,
    [int]$EmbedDims = 0,
    [int]$DbPort = 3306,
    [int]$Port = 8787,
    [switch]$SkipStorageCheck,
    [switch]$SkipInitDb,
    [switch]$NoStart,
    [switch]$SetAutostart,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'

# LLM_EXTRA_BODY 兜底：含双引号的 JSON 走命令行会被 PowerShell 剥掉引号（实测
# {thinking:{type:disabled}} —— MiMo 的思考模式因此没关掉，一次问答多烧 600+ reasoning token、
# 慢到 23 秒）。环境变量跨进程无损，一键部署脚本用它传值。
if (-not $LlmExtraBody -and $env:ZNWD_LLM_EXTRA_BODY) { $LlmExtraBody = $env:ZNWD_LLM_EXTRA_BODY }

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
        (Join-Path $env:ProgramFiles 'MySQL\MySQL Server*\bin\mysql.exe'),
        (Join-Path $env:ProgramW6432 'MySQL\MySQL Server*\bin\mysql.exe'),
        'D:\MySQL\MySQL Server*\bin\mysql.exe',
        'E:\MySQL\MySQL Server*\bin\mysql.exe',
        'C:\MySQL\*\bin\mysql.exe'
    )
    # Pattern note: keep the star glued to Server ("MySQL Server*"): it matches both
    # the MSI default dir "MySQL Server 8.4" and a manual unzip "MySQL Server9.7".
    # A space before the star misses the latter (verified on a real machine).
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

# 从包内 jar 读期望版本（META-INF/maven/com.znwd/hostess-server/pom.properties）。
# 读不到（包外构建、条目缺失等）返回 $null：调用方只打印实际版本、不做一致性校验。
function Get-JarVersion([string]$jarPath) {
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        $zip = [System.IO.Compression.ZipFile]::OpenRead($jarPath)
        try {
            $entry = $zip.GetEntry('META-INF/maven/com.znwd/hostess-server/pom.properties')
            if (-not $entry) { return $null }
            $reader = New-Object System.IO.StreamReader($entry.Open())
            try { $props = $reader.ReadToEnd() } finally { $reader.Dispose() }
            if ($props -match '(?m)^version=(.+)$') { return $Matches[1].Trim() }
        } finally {
            $zip.Dispose()
        }
    } catch { return $null }
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
# java -version 把版本号写到 stderr；在 $ErrorActionPreference='Stop' 下，PowerShell 5.1 会把
# 原生命令的 stderr 当成终止性错误（NativeCommandError），脚本会恰好在这里中断——实测部署走到
# 这一行就退出、后面的建库/启动全都没跑。这里临时放宽 EAP，拿完输出再恢复。
$eapJava = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { $verText = (& $javaCmd -version 2>&1 | Out-String) } finally { $ErrorActionPreference = $eapJava }
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

    # 先确认库端口真的通：早失败、报清原因（比 mysql 自己抛 Access denied 好查）
    $dbReady = $false
    for ($i = 0; $i -lt 15; $i++) {
        try {
            $probe = New-Object System.Net.Sockets.TcpClient
            $iar = $probe.BeginConnect('127.0.0.1', $DbPort, $null, $null)
            if ($iar.AsyncWaitHandle.WaitOne(1000) -and $probe.Connected) { $dbReady = $true }
            $probe.Close()
        } catch { }
        if ($dbReady) { break }
        Start-Sleep -Seconds 2
    }
    if (-not $dbReady) {
        Die "连不上 MySQL 127.0.0.1:$DbPort（等了 30 秒）。检查 MySQL 服务是否在跑，以及端口是否正确（不是 3306 就用 -DbPort 指定）。"
    }
    Ok "MySQL 端口可达：127.0.0.1:$DbPort"

    $initSqlPath = Join-Path $AppDir 'server\db\init.sql'
    if (-not (Test-Path -LiteralPath $initSqlPath)) { Die "缺少 $initSqlPath" }

    $sqlText = [System.IO.File]::ReadAllText($initSqlPath, [System.Text.Encoding]::UTF8)
    $sqlText = $sqlText.Replace('CHANGE_ME_znwd', $DbPassword)

    if (-not $RootPassword) {
        if ($NonInteractive) {
            Die "非交互模式执行 init.sql 必须知道 MySQL root 口令：传 -RootPassword，或让安装目录下有上次部署生成的「部署结果.txt」（里面记着 MYSQL_ROOT_PASSWORD）。库已经建好时也可以用 -SkipInitDb 跳过这一步。"
        }
        $RootPassword = Read-Secret "MySQL $RootUser 口令（用于执行 init.sql）"
    }

    $tmpSql = Join-Path ([System.IO.Path]::GetTempPath()) ("znwd-init-" + [Guid]::NewGuid().ToString('N') + '.sql')
    [System.IO.File]::WriteAllText($tmpSql, $sqlText, (New-Object System.Text.UTF8Encoding($false)))

    $oldPwd = $env:MYSQL_PWD
    $env:MYSQL_PWD = $RootPassword
    try {
        Info "正在执行 init.sql（建库 + 建账号，目标 127.0.0.1:$DbPort）..."
        # 用 cmd 的文件重定向把 SQL 原样喂给客户端。不要改成 Get-Content -Raw | mysql 那种管道：
        # PowerShell 会按控制台编码把文本重新编码，UTF-8 中文一旦出现在语句里就会被改写
        # （实测 400 字节样本过管道后只剩 270 字节，注释全被打乱；语句里的中文会直接报语法错）。
        & cmd.exe /c "`"$MysqlExe`" --protocol=TCP -h 127.0.0.1 -P $DbPort -u $RootUser --default-character-set=utf8mb4 < `"$tmpSql`""
        if ($LASTEXITCODE -ne 0) { Die "init.sql 执行失败（退出码 $LASTEXITCODE）。检查 root 账号/口令、MySQL 是否在跑、端口 $DbPort 是否正确。" }
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
$lines.Add("DB_PORT=$DbPort")
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
if ($EmbedDims -gt 0) { $lines.Add("EMBED_DIMS=$EmbedDims") }
if ($AudioProvider) { $lines.Add("AUDIO_PROVIDER=$AudioProvider") }
if ($AudioVoice)    { $lines.Add("AUDIO_VOICE=$AudioVoice") }
if ($AudioBaseUrl)  { $lines.Add("AUDIO_BASE_URL=$AudioBaseUrl") }
if ($AudioApiKey)   { $lines.Add("AUDIO_API_KEY=$AudioApiKey") }
$lines.Add($end)

$newContent = $content + "`r`n`r`n" + ($lines -join "`r`n") + "`r`n"
[System.IO.File]::WriteAllText($envPath, $newContent, (New-Object System.Text.UTF8Encoding($false)))
Ok "已写入配置: $envPath"
if ($Port -ne 8787) {
    Warn "服务端口不是默认 8787：停/查服务必须带端口 —— tools\windows\stop-znwd.cmd --port $Port（status 同理），或先 set ZNWD_PORT=$Port 再执行。"
}
if ($DbPort -ne 3306) { Info "数据库端口已按 $DbPort 写入 .env 的 DB_PORT。" }

# ---- 5. 启动 + 验收 -----------------------------------------------------
if ($NoStart) {
    Info '按要求只写配置、不启动（-NoStart）。'
} else {
    $startCmd = Join-Path $AppDir 'tools\windows\start-znwd.cmd'
    if (-not (Test-Path -LiteralPath $startCmd)) { Die "缺少启动脚本: $startCmd" }
    $expectedVersion = Get-JarVersion (Join-Path $AppDir 'server\target\hostess-server.jar')
    Info "启动服务（端口 $Port）..."
    & $startCmd --port $Port
    $startRc = $LASTEXITCODE
    if ($startRc -ne 0) {
        # start-znwd.cmd：2 = 端口已被占用（没有起新实例）；1 = jar/java 缺失或启动异常
        if ($startRc -eq 2) {
            Die "start-znwd.cmd 报端口占用（退出码 2）：端口 $Port 已在监听，本次没有启动新实例。先跑 tools\windows\stop-znwd.cmd 停掉旧实例，或换端口重试。"
        }
        Die "start-znwd.cmd 启动失败（退出码 $startRc）：jar/java 缺失或启动异常。看上方输出与 server\run.out.log。"
    }

    Info '等待健康检查（最多 120 秒）...'
    $health = $null
    $lastPartial = $null
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        try {
            $raw = & curl.exe -s --max-time 5 "http://127.0.0.1:$Port/api/health" 2>$null
            if ($raw) {
                $j = $raw | ConvertFrom-Json
                # 光看 ok+ready 不够：Tomcat 在「知识库发布 + 数据库探活」之前就已经在监听，
                # 端口一活健康接口就 200，此刻 storageAvailable 还是 false（实测会拿到这个中间态）。
                # 一体机的上线判据包含 storageAvailable=true，所以一起等。
                $isReady = if ($SkipStorageCheck) { $j.ok -and $j.ready } else { $j.ok -and $j.ready -and $j.storageAvailable }
                if ($isReady) { $health = $j; break }
                if ($j.ok -and $j.ready) { $lastPartial = $j }
            }
        } catch { }
    }
    if ($health) {
        Ok '健康检查通过：'
        Write-Host ("      ok={0}  ready={1}  storageAvailable={2}  knowledgeChunks={3}" -f `
            $health.ok, $health.ready, $health.storageAvailable, $health.knowledgeChunks)
        Write-Host ("      version={0}（/api/health 实报）" -f $health.version)
        if ($expectedVersion) {
            # 一致性校验：端口上应答的实例必须是本包的 jar，否则就是打到了旧实例
            if (-not $health.version) {
                Warn "包内 jar=$expectedVersion，但 /api/health 未返回 version 字段，本次未做版本一致性校验。"
            } elseif ($health.version -ne $expectedVersion) {
                Die "版本不一致：包内 jar=$expectedVersion，但 /api/health 报 version=$($health.version)——端口 $Port 上跑的不是本包实例。先 tools\windows\stop-znwd.cmd 再重启部署。"
            } else {
                Ok "版本与包内 jar 一致：$expectedVersion"
            }
        }
        if ($health.storageAvailable -ne $true) {
            Warn 'storageAvailable != true：数据库未连通。检查 .env 的 DB_PASSWORD 与 MySQL 服务。'
        }
        if (-not $health.knowledgeChunks -or $health.knowledgeChunks -le 0) {
            Warn 'knowledgeChunks <= 0：知识库为空，检查 knowledge\ 目录。'
        }
    } else {
        # 部署超时不能报成功：下面第 7 节会打「部署完成」，这里必须先掐断
        # 区分两种情况：服务起来了但库没连上 / 干脆没起来
        if ($lastPartial) {
            Die ("120 秒内服务已经起来（ok/ready=true）但 storageAvailable=false —— 数据库没连上。查这三处：MySQL 服务是否在跑；" +
                 ".env 的 DB_HOST/DB_PORT/DB_PASSWORD 是否与 init.sql 里的一致（本次按端口 $DbPort 写入）；库是否已建（init.sql 是否跑过）。" +
                 "确实不打算配本机库的演示机，用 -SkipStorageCheck 跳过这项判据。")
        }
        Die '120 秒内未通过健康检查，部署失败（不打「部署完成」）。查看日志 server\run.out.log，或运行 status-znwd.cmd 排查。'
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
if ($health) { Write-Host ("  服务版本 : {0}（/api/health 实报）" -f $health.version) }
Write-Host ("  ADMIN_TOKEN: {0}" -f $AdminToken)
if ($Port -ne 8787) {
    Write-Host ("  启停/状态: tools\windows\stop-znwd.cmd --port {0} / status-znwd.cmd --port {0}（端口非默认，必须带 --port）" -f $Port)
} else {
    Write-Host '  启停/状态: tools\windows\start-znwd.cmd / stop-znwd.cmd / status-znwd.cmd'
}
Write-Host ("  数据库    : 127.0.0.1:{0} / znwd" -f $DbPort)
Write-Host ''
