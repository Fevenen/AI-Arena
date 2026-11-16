@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [AI Arena] 未找到 Node.js。请安装 Node.js 20 或更新版本，并重新打开命令行。
  pause
  exit /b 1
)
node apps\server\index.mjs
if errorlevel 1 pause
endlocal
