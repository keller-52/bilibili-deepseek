@echo off
setlocal
cd /d "%~dp0"
start "bili-duty" /min cmd /c "node src\server.mjs"
timeout /t 2 >nul
start "" "http://127.0.0.1:7801"
