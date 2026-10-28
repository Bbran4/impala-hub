@echo off
REM Runs the agent. Extra arguments are passed through, e.g.:
REM   run_agent.bat --check
REM   run_agent.bat --run-job "Sales lines"
cd /d "%~dp0"
".venv\Scripts\python.exe" impala_bi_agent.py --config config.toml %*
