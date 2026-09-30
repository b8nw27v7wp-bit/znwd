<#
  install-autostart.ps1 - register or remove the znwd-hostess auto-start task.

  Default (-AtLogon): the task runs start-znwd.cmd when the current user
  logs on. No administrator rights are required.
  -AtStartup: registers an ONSTART task that runs as SYSTEM. Requires an
  elevated PowerShell window.
  -Remove: deletes the scheduled task and exits.

  The script is idempotent: an existing task with the same name is removed
  before the new one is created.

  Examples:
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -AtStartup
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove
    powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Port 8788

  NOTE: keep this file ASCII-only (or UTF-8 with BOM). PowerShell 5.1
  decodes a BOM-less non-ASCII file as ANSI and can break the script.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$AtStartup,
    [switch]$AtLogon,
    [switch]$Remove,
    [int]$Port = 8787,
    [string]$TaskName = 'znwd-hostess'
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Schtasks {
    param([string[]]$Arguments)
    # Local preferences prevent two PS 5.1 traps:
    #   * 'Stop' turns native stderr ("task not found") into a terminating error
    #   * -WhatIf would suppress the temp file creation/redirection below
    $savedEap = $ErrorActionPreference
    $savedWhatIf = $WhatIfPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $WhatIfPreference = $false
    $errFile = [IO.Path]::GetTempFileName()
    try {
        # $null on stdin so a password prompt cannot block the script
        $stdout = @($null | & schtasks.exe @Arguments 2>$errFile)
        $code = $LASTEXITCODE
        $stderr = ''
        if ((Get-Item -LiteralPath $errFile).Length -gt 0) {
            $stderr = [IO.File]::ReadAllText($errFile, [Text.Encoding]::Default)
        }
        $text = (@($stdout) + @($stderr)) -join "`n"
        return [pscustomobject]@{ Code = $code; Text = $text.Trim() }
    } finally {
        $ErrorActionPreference = $savedEap
        $WhatIfPreference = $savedWhatIf
        Remove-Item -LiteralPath $errFile -Force -WhatIf:$false -ErrorAction SilentlyContinue
    }
}

function Test-TaskExists {
    param([string]$Name)
    $result = Invoke-Schtasks @('/Query', '/TN', $Name)
    return ($result.Code -eq 0)
}

function Remove-Task {
    param([string]$Name)
    $result = Invoke-Schtasks @('/Delete', '/TN', $Name, '/F')
    if ($result.Code -eq 0) {
        return $true
    }
    # covers tasks that were registered with the ScheduledTasks module
    try {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

$startCmd = Join-Path $PSScriptRoot 'start-znwd.cmd'
if (-not (Test-Path -LiteralPath $startCmd)) {
    Write-Host "[ERROR] start-znwd.cmd not found next to this script: $startCmd"
    exit 1
}

if ($AtLogon -and $AtStartup) {
    Write-Host '[ERROR] Use either -AtLogon (default) or -AtStartup, not both.'
    exit 1
}

if ($Remove) {
    if (-not (Test-TaskExists -Name $TaskName)) {
        Write-Host "[INFO] Scheduled task '$TaskName' does not exist. Nothing to remove."
        exit 0
    }
    if (-not $PSCmdlet.ShouldProcess("scheduled task '$TaskName'", 'Remove')) {
        exit 0
    }
    if (Remove-Task -Name $TaskName) {
        Write-Host "[OK] Scheduled task '$TaskName' removed."
        exit 0
    }
    Write-Host "[ERROR] Could not remove scheduled task '$TaskName'."
    exit 1
}

$mode = if ($AtStartup) { 'AtStartup' } else { 'AtLogon' }
$currentUser = "$env:USERDOMAIN\$env:USERNAME"

if ($mode -eq 'AtStartup') {
    if (-not (Test-Admin)) {
        Write-Host '[ERROR] -AtStartup registers a SYSTEM task and requires administrator rights.'
        Write-Host '        Open PowerShell as Administrator and run the command again.'
        exit 1
    }
    # a SYSTEM task only sees the machine-wide PATH
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $machineJava = $false
    foreach ($dir in ($machinePath -split ';')) {
        $trimmed = $dir.Trim()
        if ($trimmed -and (Test-Path -LiteralPath (Join-Path $trimmed 'java.exe'))) {
            $machineJava = $true
            break
        }
    }
    if (-not $machineJava -and -not [Environment]::GetEnvironmentVariable('JAVA_HOME', 'Machine')) {
        Write-Host '[WARN] java.exe was not found in the machine-wide PATH and no machine JAVA_HOME is set.'
        Write-Host '       A SYSTEM task cannot see the per-user PATH. Install the JDK machine-wide or add'
        Write-Host '       its bin folder to the system PATH before relying on auto-start.'
    }
}

if (Test-TaskExists -Name $TaskName) {
    if (-not $PSCmdlet.ShouldProcess("scheduled task '$TaskName'", 'Remove the existing task')) {
        exit 0
    }
    if (-not (Remove-Task -Name $TaskName)) {
        Write-Host "[ERROR] An existing task '$TaskName' exists but could not be removed."
        exit 1
    }
    Write-Host "[INFO] Removed the existing task '$TaskName'."
}

$action = '"' + $startCmd + '" --port ' + $Port
$created = $false

if ($mode -eq 'AtLogon') {
    if (-not $PSCmdlet.ShouldProcess("scheduled task '$TaskName'", "Create at logon of $currentUser")) {
        exit 0
    }
    $result = Invoke-Schtasks @('/Create', '/TN', $TaskName, '/SC', 'ONLOGON',
        '/RU', $currentUser, '/RL', 'LIMITED', '/TR', $action, '/F')
    if ($result.Code -eq 0) {
        $created = $true
    } else {
        Write-Host "[INFO] schtasks could not create the logon task (exit $($result.Code))."
        if ($result.Text) {
            Write-Host "       $($result.Text)"
        }
        Write-Host '       Falling back to the ScheduledTasks PowerShell module.'
        $taskAction = New-ScheduledTaskAction -Execute $startCmd -Argument "--port $Port"
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
        try {
            Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger `
                -Principal $principal -Force -ErrorAction Stop | Out-Null
            $created = $true
        } catch {
            Write-Host "[ERROR] $($_.Exception.Message)"
        }
    }
} else {
    if (-not $PSCmdlet.ShouldProcess("scheduled task '$TaskName'", 'Create as SYSTEM at system startup')) {
        exit 0
    }
    $result = Invoke-Schtasks @('/Create', '/TN', $TaskName, '/SC', 'ONSTART',
        '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/TR', $action, '/F')
    if ($result.Code -eq 0) {
        $created = $true
    } else {
        Write-Host "[ERROR] schtasks failed (exit $($result.Code))."
        Write-Host "        $($result.Text)"
    }
}

if (-not $created) {
    Write-Host "[ERROR] Failed to register scheduled task '$TaskName'."
    exit 1
}

Write-Host "[OK] Scheduled task '$TaskName' registered (mode: $mode, port: $Port)."
Write-Host "     Action: $startCmd --port $Port"
Write-Host "     Check : schtasks /Query /TN $TaskName"
Write-Host '     Remove: powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove'
if ($mode -eq 'AtLogon') {
    Write-Host "     It starts when user '$currentUser' logs on."
} else {
    Write-Host '     It starts at system boot as SYSTEM.'
}
exit 0
