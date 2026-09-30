@echo off
rem ============================================================
rem  start-znwd.cmd - start the znwd hostess server on Windows
rem
rem  Usage:
rem    start-znwd.cmd                start on port 8787
rem    start-znwd.cmd --port 8788    start on another port
rem    set ZNWD_PORT=8788 ^& start-znwd.cmd
rem
rem  The server runs in a separate minimized window and keeps
rem  running after this script exits. Its output is appended to
rem  server\run.out.log. Starting a second instance on the same
rem  port is refused.
rem
rem  Requirements: JDK 21+ (java on PATH, or JAVA_HOME set),
rem  MySQL 8+ running as a Windows service (auto start).
rem ============================================================
setlocal EnableExtensions

set "PORT=8787"
if defined ZNWD_PORT set "PORT=%ZNWD_PORT%"
if /I "%~1"=="--port" if not "%~2"=="" set "PORT=%~2"

rem -- resolve the repository root from this script location --
set "ROOT=%~dp0..\.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "SERVER=%ROOT%\server"
set "JAR=%SERVER%\target\hostess-server.jar"

if not exist "%JAR%" (
  echo [ERROR] Jar not found: "%JAR%"
  echo         Build it first:  cd server ^&^& mvn -B -DskipTests package
  exit /b 1
)

rem -- refuse to start when the port is already listening --
netstat -ano -p tcp | findstr "LISTENING" | findstr /C:":%PORT% " >nul 2>&1
if not errorlevel 1 (
  echo [WARN] Port %PORT% is already listening. Nothing was started.
  echo        Run stop-znwd.cmd first, or choose another port with --port.
  exit /b 2
)

rem -- locate java: PATH first, then JAVA_HOME --
set "JAVACMD="
where java >nul 2>&1 && set "JAVACMD=java"
if not defined JAVACMD if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" set "JAVACMD="%JAVA_HOME%\bin\java.exe""
if not defined JAVACMD (
  echo [ERROR] java not found. Install JDK 21+ and add it to PATH,
  echo         or set JAVA_HOME to the JDK install folder.
  exit /b 1
)

rem -- port 8787 is the application default, do not pass it twice --
set "PORTARG="
if not "%PORT%"=="8787" set "PORTARG= --server.port=%PORT%"

rem -- one log file per port; two instances must not fight over the same handle --
set "LOG=run.out.log"
if not "%PORT%"=="8787" set "LOG=run-%PORT%.out.log"

echo [INFO] Repository : %ROOT%
echo [INFO] Working dir: %SERVER%
echo [INFO] Port       : %PORT%
echo [INFO] Log        : %SERVER%\%LOG%

pushd "%SERVER%"
if errorlevel 1 (
  echo [ERROR] Cannot enter "%SERVER%".
  exit /b 1
)
start "znwd-hostess" /MIN cmd /c "%JAVACMD% -jar target\hostess-server.jar --spring.main.banner-mode=off%PORTARG% >> %LOG% 2>&1"
set "START_RC=%errorlevel%"
popd
if not "%START_RC%"=="0" (
  echo [ERROR] Failed to launch java - start errorlevel %START_RC%.
  exit /b 1
)

echo [INFO] Started. Check with status-znwd.cmd
echo [INFO] Health : http://127.0.0.1:%PORT%/api/health
exit /b 0
