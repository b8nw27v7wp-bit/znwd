@echo off
rem ============================================================
rem  status-znwd.cmd - show the znwd hostess server status
rem
rem  Prints:
rem    1) whether the port (default 8787) is LISTENING and its PID
rem    2) the command lines of all running java.exe processes
rem    3) the response of GET /api/health (uses curl.exe)
rem
rem  Usage:
rem    status-znwd.cmd
rem    status-znwd.cmd --port 8788
rem    set ZNWD_PORT=8788 ^& status-znwd.cmd
rem ============================================================
setlocal EnableExtensions

set "PORT=8787"
if defined ZNWD_PORT set "PORT=%ZNWD_PORT%"
if /I "%~1"=="--port" if not "%~2"=="" set "PORT=%~2"

echo === znwd-hostess status (port %PORT%) ===
echo.

rem -- 1) port listener --
set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr "LISTENING" ^| findstr /C:":%PORT% "') do (
  set "FOUND=1"
  echo [LISTEN] Port %PORT% is listening, PID %%P
)
if not defined FOUND echo [LISTEN] Port %PORT% is NOT listening.

rem -- 2) java process command lines --
echo.
echo [JAVA] java.exe processes:
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'java.exe' } | ForEach-Object { '  PID ' + $_.ProcessId + ' : ' + $_.CommandLine }"

rem -- 3) health endpoint --
echo.
where curl >nul 2>&1
if errorlevel 1 (
  echo [HEALTH] curl not found. Open http://127.0.0.1:%PORT%/api/health in a browser.
) else (
  echo [HEALTH] http://127.0.0.1:%PORT%/api/health
  curl -s --max-time 5 http://127.0.0.1:%PORT%/api/health
  echo.
)
exit /b 0
