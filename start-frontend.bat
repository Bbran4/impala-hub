@echo off
title Impala Hub Frontend
cd /d "%~dp0frontend"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22 or newer from nodejs.org.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing frontend packages, this takes a minute the first time...
  call npm install
)

echo Starting the frontend on http://127.0.0.1:5173  (press Ctrl+C to stop)
call npm run dev
pause
