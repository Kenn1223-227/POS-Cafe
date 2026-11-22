@echo off
chcp 65001 >nul
title Cafe POS - Dang ky khoi dong cung Windows (1-Click Auto-Start)
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "BRIDGE_BAT=%~dp0start-bridge.bat"
set "VBS_LAUNCHER=%STARTUP_DIR%\CafePOS-PrintAgent.vbs"

echo Set WshShell = CreateObject("WScript.Shell") > "%VBS_LAUNCHER%"
echo WshShell.Run chr(34) ^& "%BRIDGE_BAT%" ^& chr(34), 0 >> "%VBS_LAUNCHER%"
echo Set WshShell = Nothing >> "%VBS_LAUNCHER%"

echo ==============================================================
echo [OK] Da cai dat CafePOS-PrintAgent tu dong chay ngam cung Windows!
echo      Duong dan Startup: %VBS_LAUNCHER%
echo ==============================================================
pause
