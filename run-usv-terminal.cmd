@echo off
rem Convenience launcher: starts the new terminal (desktop/) in real application mode.
rem Auto-discovers the boat on UDP 9528; no IP needed.
call "%~dp0desktop\run-terminal.cmd" %*
