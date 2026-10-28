@echo off
setlocal
title USV Terminal - SIM
rem ============================================================
rem  USV Terminal - simulator mode
rem    - starts a fake boat: 12m square pool + obstacles + ideal lidar
rem    - collision stops the boat; point-mass kinematics
rem    - then launches the terminal, which auto-discovers it on UDP 9528
rem  ASCII only on purpose (cmd codepage safety).
rem ============================================================

set "PATH=%PATH%;C:\Program Files\nodejs"
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [1/3] Installing dependencies ^(first run^) ...
  call npm install || goto :fail
)

if not exist "dist\main\index.js" (
  echo [2/3] Building ...
  call npm run build || goto :fail
)

echo [3/3] Starting pool simulator ^(12m x 12m, 4 obstacles^) ...
start "USV SIM - pool 12x12" cmd /k node tools\sim-boat.cjs
timeout /t 2 /nobreak >nul

echo Starting USV Terminal ...
echo   fake boat      : SIM-USV on TCP 9527 / UDP 9528
echo   start position : (6.0, 2.6) heading 90 deg
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
