@echo off
start "Impala Hub API" cmd /k "%~dp0start-api.bat"
start "Impala Hub Frontend" cmd /k "%~dp0start-frontend.bat"
echo Waiting a few seconds for both to start...
timeout /t 8 /nobreak >nul
start http://127.0.0.1:5173
