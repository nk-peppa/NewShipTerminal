@echo off
setlocal
title Build firmware on Pi
rem ============================================================
rem  Builds the firmware on the Orange Pi (native aarch64) and
rem  copies the .tar.gz back to desktop\dist\firmware for OTA.
rem  ASCII only on purpose (cmd codepage safety).
rem
rem  Why not build locally on Windows: this machine has the VS
rem  compiler but no Windows 10/11 SDK libs (kernel32.lib), and no
rem  MinGW either -- so MSVC/GNU linking is impossible. Building on
rem  the Pi is what OTA has always used, so this changes nothing
rem  about the upgrade path; it just makes it one click.
rem ============================================================

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-remote.ps1" %*
echo.
pause
