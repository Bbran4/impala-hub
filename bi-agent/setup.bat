@echo off
REM One-time setup: creates a Python virtual environment and installs the agent's packages.
REM Needs Python 3.11 or newer (https://www.python.org/downloads/windows/).
cd /d "%~dp0"
py -3 -m venv .venv || python -m venv .venv
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if not exist config.toml copy config.example.toml config.toml
if not exist tables.toml copy tables.example.toml tables.toml
echo.
echo Done. Next: edit config.toml, .env and tables.toml, then run:
echo   run_agent.bat --validate
echo   run_agent.bat --test-all
echo   run_agent.bat --check
pause
