@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-local.ps1" %*
