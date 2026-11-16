@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title AI Arena
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer was not found in PATH.
  echo Install Node.js, then double-click start.cmd again.
  pause
  exit /b 1
)
set "ARENA_OPEN_BROWSER=1"
echo.
echo Starting AI Arena...
echo Keep this window open. The browser will open automatically.
echo.
node apps\server\index.mjs
echo.
echo AI Arena has stopped.
pause
endlocal