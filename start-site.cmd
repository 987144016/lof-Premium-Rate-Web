@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE="

for %%I in (node.exe) do set "NODE_EXE=%%~$PATH:I"
if defined NODE_EXE goto run

if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.14.0-win-x64\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.14.0-win-x64\node.exe"
if defined NODE_EXE goto run

echo 未找到 Node.js，请先安装 Node.js LTS。
pause
exit /b 1

:run
if not defined AUTO_PUSH_GITHUB set "AUTO_PUSH_GITHUB=0"
if not defined AUTO_PUSH_INTERVAL_MS set "AUTO_PUSH_INTERVAL_MS=300000"
if not defined SYNC_STARTUP_FULL_FIRST set "SYNC_STARTUP_FULL_FIRST=1"
if not defined SYNC_BOOTSTRAP_BATCH_SIZE set "SYNC_BOOTSTRAP_BATCH_SIZE=9999"
if not defined SYNC_BATCH_SIZE set "SYNC_BATCH_SIZE=8"
"%NODE_EXE%" scripts\dev-auto-refresh.mjs
endlocal
