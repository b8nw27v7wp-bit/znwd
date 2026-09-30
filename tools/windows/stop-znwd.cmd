@echo off
rem ============================================================
rem  stop-znwd.cmd - stop the znwd hostess server on Windows
rem
rem  Finds the process that LISTENS on the port (default 8787)
rem  and kills it with taskkill /F.
rem
rem  Usage:
rem    stop-znwd.cmd                stop the server on port 8787
rem    stop-znwd.cmd --port 8788    stop the server on another port
rem    set ZNWD_PORT=8788 ^& stop-znwd.cmd
rem
rem  Safe to run when nothing is listening (reports and exits).
rem ============================================================
setlocal EnableExtensions

set "PORT=8787"
if defined ZNWD_PORT set "PORT=%ZNWD_PORT%"
if /I "%~1"=="--port" if not "%~2"=="" set "PORT=%~2"

set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr "LISTENING" ^| findstr /C:":%PORT% "') do (
  set "FOUND=1"
  taskkill /PID %%P /F >nul 2>&1
  if not errorlevel 1 (
    echo [OK]   Stopped PID %%P on port %PORT%.
  ) else (
    echo [WARN] Could not stop PID %%P. Run this script as its owner or as administrator.
  )
)

if not defined FOUND (
  echo [INFO] Nothing is listening on port %PORT%. Server is not running.
  exit /b 0
)
exit /b 0
