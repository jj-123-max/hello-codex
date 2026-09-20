@echo off
chcp 65001 >nul
title Honglu Agent Workbench
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "NODE=%ROOT%\runtime\node\node.exe"
if not exist "%NODE%" set "NODE=node"
where "%NODE%" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node runtime not found. Please reinstall the application.
  echo         Expected: %ROOT%\runtime\node\node.exe
  pause
  exit /b 1
)
"%NODE%" "%ROOT%\launcher\launcher.js" %*
echo.
echo [Workbench stopped]  Log: %ROOT%\data\logs\launcher.log
pause
