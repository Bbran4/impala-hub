@echo off
REM ===========================================================================
REM  Impala BI agent - console
REM  Double-click it (for example from the Desktop). It asks for administrator
REM  rights, opens in the agent folder and shows a menu for the everyday jobs.
REM ===========================================================================
setlocal EnableExtensions

REM Where the agent is installed, and the GitHub clone used for updates
set "AGENT_DIR=C:\ImpalaBI\bi-agent"
set "CLONE_DIR=%USERPROFILE%\Documents\Github\impala-hub-marketing\bi-agent"
set "TASK=Impala BI Agent"

REM When this file sits inside an agent folder, use that folder
if exist "%~dp0impala_bi_agent.py" if exist "%~dp0config.toml" set "AGENT_DIR=%~dp0"
if "%AGENT_DIR:~-1%"=="\" set "AGENT_DIR=%AGENT_DIR:~0,-1%"

REM --- administrator rights (the agent folder is locked to Administrators) ----
net session >nul 2>&1
if errorlevel 1 (
  echo Asking for administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

if not exist "%AGENT_DIR%\impala_bi_agent.py" (
  echo The agent was not found in %AGENT_DIR%.
  echo Change AGENT_DIR at the top of this file.
  pause
  exit /b 1
)
cd /d "%AGENT_DIR%"
title Impala BI agent - %AGENT_DIR%

:menu
cls
echo  ============================================================
echo   Impala BI agent       %AGENT_DIR%
echo  ============================================================
echo.
echo   1  Check the connections          (run_agent.bat --check)
echo   2  Open the table picker          (ui.bat)
echo   3  Load a table or group now      (run_agent.bat --run ...)
echo   4  Show the last lines of the log
echo   5  Edit config.toml
echo   6  Edit .env (passwords)
echo   7  Edit tables.toml
echo   8  Restart the agent              (scheduled task)
echo   9  Is the agent running?
echo   U  Update the agent from the GitHub clone
echo   C  Command prompt in the agent folder
echo   0  Exit
echo.
set "pick="
set /p "pick=Choose: "
if "%pick%"=="1" goto check
if "%pick%"=="2" goto ui
if "%pick%"=="3" goto runone
if "%pick%"=="4" goto log
if "%pick%"=="5" (start "" notepad "%AGENT_DIR%\config.toml" & goto menu)
if "%pick%"=="6" (start "" notepad "%AGENT_DIR%\.env" & goto menu)
if "%pick%"=="7" (start "" notepad "%AGENT_DIR%\tables.toml" & goto menu)
if "%pick%"=="8" goto restart
if "%pick%"=="9" goto status
if /i "%pick%"=="U" goto update
if /i "%pick%"=="C" goto prompt
if "%pick%"=="0" exit /b
goto menu

:check
call run_agent.bat --check
pause
goto menu

:ui
echo The table picker opens in your browser. Close its window (or press Ctrl+C) to come back here.
call ui.bat
goto menu

:runone
set "name="
set /p "name=Table or group name (e.g. invoice): "
if "%name%"=="" goto menu
call run_agent.bat --run %name%
pause
goto menu

:log
if exist "logs\agent.log" (
  powershell -NoProfile -Command "Get-Content -Path 'logs\agent.log' -Tail 40"
) else (
  echo No log yet: logs\agent.log is created when the agent runs.
)
pause
goto menu

:restart
echo Stopping the agent (a load that is running is stopped and picked up again)...
schtasks /End /TN "%TASK%" >nul 2>&1
timeout /t 3 /nobreak >nul
schtasks /Run /TN "%TASK%"
if errorlevel 1 echo The task "%TASK%" does not exist yet: install it with install_task.ps1.
pause
goto menu

:status
schtasks /Query /TN "%TASK%" /FO LIST 2>nul | findstr /i "TaskName Status"
if errorlevel 1 echo The task "%TASK%" is not installed.
echo.
powershell -NoProfile -Command "Get-Process python*,pythonw* -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | Format-Table -AutoSize"
pause
goto menu

:update
if not exist "%CLONE_DIR%\impala_bi_agent.py" (
  echo The GitHub clone was not found in %CLONE_DIR%.
  echo Change CLONE_DIR at the top of this file.
  pause
  goto menu
)
echo Copies the agent's program files from the clone. config.toml, .env and tables.toml are NOT touched.
echo Pull the latest version in GitHub Desktop first.
set "ok="
set /p "ok=Continue? (Y/N): "
if /i not "%ok%"=="Y" goto menu
schtasks /End /TN "%TASK%" >nul 2>&1
timeout /t 3 /nobreak >nul
for %%F in (impala_bi_agent.py agent_ui.py README.md requirements.txt run_agent.bat ui.bat setup.bat install_task.ps1 config.example.toml tables.example.toml) do (
  if exist "%CLONE_DIR%\%%F" copy /Y "%CLONE_DIR%\%%F" "%AGENT_DIR%\%%F" >nul && echo   copied %%F
)
echo Installing any new Python packages...
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
call run_agent.bat --check
schtasks /Run /TN "%TASK%" >nul 2>&1 && echo Agent restarted.
pause
goto menu

:prompt
echo Type "exit" to come back to the menu.
cmd /k "cd /d "%AGENT_DIR%""
goto menu
