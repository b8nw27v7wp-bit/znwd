<#
  pack.ps1 - build and package znwd for a Windows all-in-one machine.

  Output:
    dist\znwd-<yyyy-MM-dd>\        package folder
    dist\znwd-<yyyy-MM-dd>.zip     zip of the package folder

  By default it builds the backend (mvn -B -DskipTests package in server\)
  and the frontend (npm ci + npm run build in web\) first. Use -SkipBuild
  to package the existing artifacts.

  The package mirrors the repository layout, so the scripts under
  tools\windows\ keep working unchanged inside the package:
    DEPLOY.txt
    knowledge\
    server\.env.example
    server\db\init.sql
    server\prompts\*.txt
    server\target\hostess-server.jar
    tools\windows\*.cmd *.ps1 README.md
    web\dist\

  Examples:
    powershell -ExecutionPolicy Bypass -File pack.ps1
    powershell -ExecutionPolicy Bypass -File pack.ps1 -SkipBuild
    powershell -ExecutionPolicy Bypass -File pack.ps1 -DateStamp 2026-09-30

  NOTE: keep this file ASCII-only (or UTF-8 with BOM). PowerShell 5.1
  decodes a BOM-less non-ASCII file as ANSI and can break the script.
#>

[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$DateStamp,
    [string]$DistRoot
)

$ErrorActionPreference = 'Stop'

function Copy-One {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source)) {
        throw "Missing required item: $Source"
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $DistRoot) {
    $DistRoot = Join-Path $repo 'dist'
}
if (-not $DateStamp) {
    $DateStamp = Get-Date -Format 'yyyy-MM-dd'
}

$pkgName = "znwd-$DateStamp"
$pkg = Join-Path $DistRoot $pkgName
$zip = Join-Path $DistRoot "$pkgName.zip"

$jar = Join-Path $repo 'server\target\hostess-server.jar'
$webDist = Join-Path $repo 'web\dist'
$knowledge = Join-Path $repo 'knowledge'
$initSql = Join-Path $repo 'server\db\init.sql'
$envExample = Join-Path $repo 'server\.env.example'
$promptDir = Join-Path $repo 'server\src\main\resources\prompts'

Write-Host "[INFO] Repository: $repo"
Write-Host "[INFO] Package   : $pkg"

if (-not $SkipBuild) {
    $mvn = Get-Command mvn -ErrorAction SilentlyContinue
    if (-not $mvn) {
        throw 'mvn was not found on PATH. Install Maven or pass -SkipBuild.'
    }
    Write-Host '[BUILD] mvn -B -DskipTests package (server)'
    Push-Location (Join-Path $repo 'server')
    try {
        & $mvn.Source -B -DskipTests package
        if ($LASTEXITCODE -ne 0) {
            throw "mvn package failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }

    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) {
        throw 'npm was not found on PATH. Install Node.js or pass -SkipBuild.'
    }
    Write-Host '[BUILD] npm ci (web)'
    Push-Location (Join-Path $repo 'web')
    try {
        & $npm.Source ci
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE"
        }
        Write-Host '[BUILD] npm run build (web)'
        & $npm.Source run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Host '[INFO] -SkipBuild: using existing artifacts.'
}

if (-not (Test-Path -LiteralPath $jar)) {
    throw "Jar not found: $jar. Run without -SkipBuild or build it first."
}
if (-not (Test-Path -LiteralPath $webDist)) {
    throw "web\dist not found: $webDist. Run without -SkipBuild or build it first."
}

# -- fresh package folder and zip (idempotent re-runs) --
if (Test-Path -LiteralPath $pkg) {
    Remove-Item -LiteralPath $pkg -Recurse -Force
}
if (Test-Path -LiteralPath $zip) {
    Remove-Item -LiteralPath $zip -Force
}
New-Item -ItemType Directory -Path $pkg -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $pkg 'server\db') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $pkg 'server\target') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $pkg 'server\prompts') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $pkg 'tools\windows') -Force | Out-Null

Write-Host '[COPY]  server\target\hostess-server.jar'
Copy-One -Source $jar -Destination (Join-Path $pkg 'server\target\hostess-server.jar')

Write-Host '[COPY]  server\db\init.sql'
Copy-One -Source $initSql -Destination (Join-Path $pkg 'server\db\init.sql')

Write-Host '[COPY]  server\.env.example'
Copy-One -Source $envExample -Destination (Join-Path $pkg 'server\.env.example')

$prompts = @(Get-ChildItem -Path $promptDir -Filter '*.txt' -File -ErrorAction SilentlyContinue)
if ($prompts.Count -eq 0) {
    Write-Host "[WARN] No prompt *.txt files found in $promptDir"
} else {
    Write-Host '[COPY]  server\src\main\resources\prompts\*.txt -> server\prompts\'
    foreach ($file in $prompts) {
        Copy-One -Source $file.FullName -Destination (Join-Path $pkg 'server\prompts')
    }
}

Write-Host '[COPY]  knowledge\'
Copy-One -Source $knowledge -Destination $pkg

Write-Host '[COPY]  web\dist\'
New-Item -ItemType Directory -Path (Join-Path $pkg 'web') -Force | Out-Null
Copy-One -Source $webDist -Destination (Join-Path $pkg 'web')

Write-Host '[COPY]  tools\windows\'
$scriptFiles = @(Get-ChildItem -LiteralPath $PSScriptRoot -File |
    Where-Object { $_.Extension -in '.cmd', '.ps1', '.md' })
foreach ($file in $scriptFiles) {
    Copy-One -Source $file.FullName -Destination (Join-Path $pkg 'tools\windows')
}

# -- DEPLOY.txt (ASCII only, generated on purpose) --
$deployText = @"
============================================================
 znwd hostess - Windows deployment package
 built: $DateStamp
============================================================

TARGET MACHINE REQUIREMENTS
  - Windows with PowerShell 5.1 (built in) and cmd.exe
  - JDK 21+        (java.exe on PATH, or JAVA_HOME set)
  - MySQL 8+       (running as an auto-start Windows service)

FILES IN THIS PACKAGE
  server\target\hostess-server.jar   the API server
  server\.env.example                configuration template
  server\db\init.sql                 MySQL bootstrap script
  server\prompts\*.txt               optional external prompt texts
  knowledge\                         knowledge base files
  web\dist\                          built frontend files
  tools\windows\                     start/stop/status/autostart scripts

DEPLOY STEPS
  1) Open server\db\init.sql and replace both CHANGE_ME_znwd
     placeholders with your own password for the 'znwd' MySQL user.
  2) Run it once with a MySQL administrator account, for example:
       mysql -u root -p < server\db\init.sql
  3) Copy server\.env.example to server\.env and edit server\.env:
       DB_PASSWORD   same password as in step 1
       ADMIN_TOKEN   long random string (admin APIs require it)
       LLM_*         provider / base url / api key / model
       EMBED_*       provider / base url / api key / model
       AUDIO_*       optional speech (AUDIO_PROVIDER=none disables it)
       WEB_DIST_DIR  optional, default ./web/dist (see NOTE below)
  4) Double-click tools\windows\start-znwd.cmd
     The server starts in a separate minimized window and appends
     its output to server\run.out.log.
  5) Open http://127.0.0.1:8787/ in a browser on this machine.
  6) Optional auto-start:
       powershell -ExecutionPolicy Bypass -File tools\windows\install-autostart.ps1
       powershell -ExecutionPolicy Bypass -File tools\windows\install-autostart.ps1 -AtStartup
       powershell -ExecutionPolicy Bypass -File tools\windows\install-autostart.ps1 -Remove
     (-AtStartup needs an elevated PowerShell window.)

OTHER SCRIPTS
  tools\windows\stop-znwd.cmd     stop the server listening on the port
  tools\windows\status-znwd.cmd   show port, java processes, /api/health

PORT
  Default 8787. Override with the ZNWD_PORT environment variable or
  with the first argument, for example:
    start-znwd.cmd --port 8788

NOTE
  The jar serves the built frontend automatically: when
  web\dist\index.html exists (or WEB_DIST_DIR points to a folder
  with index.html), opening http://127.0.0.1:8787/ shows the whole
  app, same origin as /api - no static server and no CORS needed.
  If web\dist is missing the jar still runs and only serves the API.
"@
$deployPath = Join-Path $pkg 'DEPLOY.txt'
[IO.File]::WriteAllText($deployPath, $deployText, [Text.Encoding]::ASCII)
Write-Host '[MAKE]  DEPLOY.txt'

# -- zip --
Write-Host "[ZIP]   $zip"
Compress-Archive -Path (Join-Path $pkg '*') -DestinationPath $zip -CompressionLevel Optimal

$zipSize = (Get-Item -LiteralPath $zip).Length
$pkgFiles = @(Get-ChildItem -LiteralPath $pkg -Recurse -File)
Write-Host ''
Write-Host "[OK] Package folder: $pkg ($($pkgFiles.Count) files)"
Write-Host "[OK] Zip archive   : $zip ($([math]::Round($zipSize / 1MB, 2)) MB)"
Write-Host "[OK] Next step     : copy the zip to the target machine, extract it, read DEPLOY.txt"
