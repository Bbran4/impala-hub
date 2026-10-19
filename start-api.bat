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
  echo Creating .env with a new random API key...
  copy .env.example .env >nul
  python -c "import secrets,re,pathlib;p=pathlib.Path('.env');k=secrets.token_urlsafe(32);p.write_text(re.sub(r'APP_API_KEY=.*','APP_API_KEY='+k,p.read_text()));print();print('YOUR API KEY - type this into the web app:');print(k);print()"
)

echo Starting the API on http://127.0.0.1:8000  (press Ctrl+C to stop)
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
pause
