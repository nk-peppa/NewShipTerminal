@echo off
setlocal
title USV Terminal - SIM
rem Starts the pool simulator, then the terminal (both via run-terminal.ps1).
rem ASCII only on purpose (cmd codepage safety).

set "PATH=%PATH%;C:\Program Files\nodejs;C:\Program Files\Git\cmd"
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-terminal.ps1" -Sim %*
exit /b %errorlevel%