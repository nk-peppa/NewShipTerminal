@echo off
setlocal
title USV Terminal
rem ============================================================
rem  USV Terminal - entry point
rem    All logic lives in run-terminal.ps1: dependency check,
rem    auto-update (release branch only), build, launch.
rem  ASCII only on purpose (cmd codepage safety).
rem ============================================================

set "PATH=%PATH%;C:\Program Files\nodejs;C:\Program Files\Git\cmd"
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-terminal.ps1" %*
exit /b %errorlevel%