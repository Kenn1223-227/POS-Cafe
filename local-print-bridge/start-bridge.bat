@echo off
title Cafe POS - Local Print Bridge Agent (Port 9100)
echo Dang khoi dong Cafe POS Local Print Bridge tai http://127.0.0.1:9100 ...
node "%~dp0bridge-server.js"
pause
