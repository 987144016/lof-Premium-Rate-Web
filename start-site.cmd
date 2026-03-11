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
"%NODE_EXE%" scripts\dev-auto-refresh.mjs
endlocal
