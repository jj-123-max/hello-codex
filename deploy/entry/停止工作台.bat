@echo off
chcp 65001 >nul
title Stop Honglu Agent Workbench
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "NODE=%ROOT%\runtime\node\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%ROOT%\launcher\launcher.js" --stop
echo.
pause
