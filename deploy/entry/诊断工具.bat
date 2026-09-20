@echo off
chcp 65001 >nul
title Honglu Agent Workbench - Diagnostics
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "NODE=%ROOT%\runtime\node\node.exe"
if not exist "%NODE%" set "NODE=node"

echo ============================================================
echo  [1/3] Installation integrity check
echo ============================================================
"%NODE%" "%ROOT%\launcher\launcher.js" --selfcheck
echo.

echo ============================================================
echo  [2/3] Update source connectivity
echo ============================================================
"%NODE%" "%ROOT%\launcher\launcher.js" --check-only
echo.

echo ============================================================
echo  [3/3] Recent launcher log (last 40 lines)
echo ============================================================
if exist "%ROOT%\data\logs\launcher.log" (
  powershell -NoProfile -Command "Get-Content -Path '%ROOT%\data\logs\launcher.log' -Tail 40"
) else (
  echo (no launcher.log yet)
)
echo.
echo Diagnostics finished. Press any key to close.
pause >nul
