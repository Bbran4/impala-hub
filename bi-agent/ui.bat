@echo off
REM Opens the table picker in your browser: browse the ERP (ODBC) tables, choose what to load,
REM test it, save tables.toml and publish to Supabase. Only this computer can open it.
REM Run it as an Administrator (the agent folder is locked down to Administrators).
cd /d "%~dp0"
".venv\Scripts\python.exe" impala_bi_agent.py --config config.toml --ui %*
