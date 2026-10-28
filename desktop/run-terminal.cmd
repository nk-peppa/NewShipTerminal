@echo off
setlocal
title USV Terminal
rem ============================================================
rem  USV Terminal - real application mode
rem    - auto-discovers the boat on UDP 9528 (no hardcoded IP)
rem    - control TCP 9527 / OTA 9530
rem    - builds automatically on first run
rem  ASCII only on purpose (cmd codepage safety).
rem ============================================================

set "PATH=%PATH%;C:\Program Files\nodejs"
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/2] Installing dependencies ^(first run^) ...
  call npm install || goto :fail
)

if not exist "dist\main\index.js" (
  echo [2/2] Building ...
  call npm run build || goto :fail
)

echo Starting USV Terminal ...
echo   boat discovery : UDP 9528 ^(auto^)
echo   control        : TCP 9527
echo   firmware OTA   : TCP 9530
echo.
"node_modules\electron\dist\electron.exe" .
if errorlevel 1 (
  echo.
  echo Terminal exited with code %errorlevel%.
  pause
)
exit /b 0

:fail
echo.
echo Build failed. Run "npm install" / "npm run build" manually to see details.
pause
exit /b 1
