@echo off
title Impala Hub API
cd /d "%~dp0backend"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install Python 3.11 or newer from python.org and tick "Add Python to PATH".
  pause
  exit /b 1
)

if not exist .venv (
  echo Creating virtual environment...
  python -m venv .venv
)
call .venv\Scripts\activate.bat

echo Installing packages...
pip install -q -r requirements.txt

if not exist .env (
  echo Creating backend/.env from the example configuration...
  copy .env.example .env >nul
  echo Set RFQ_BOOTSTRAP_ADMIN_USERNAME and RFQ_BOOTSTRAP_ADMIN_PASSWORD in backend/.env before signing in.
)

echo Starting the API on http://127.0.0.1:8000
echo Health check: http://127.0.0.1:8000/api/health
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
pause
