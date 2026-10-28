# Installs the agent as a Windows scheduled task that starts with the computer and
# restarts itself if it stops, and locks the agent folder down.
# Run in an elevated (Administrator) PowerShell:
#   powershell -ExecutionPolicy Bypass -File install_task.ps1
#
# The task runs as SYSTEM, so any ODBC DSN must be a *System* DSN.

$ErrorActionPreference = "Stop"
$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = "Impala BI Agent"

if (-not (Test-Path "$dir\config.toml")) { throw "config.toml not found in $dir" }
if (-not (Test-Path "$dir\tables.toml")) { throw "tables.toml not found in $dir" }

# 1. Only SYSTEM and Administrators may read or change the agent folder
#    (it holds the ERP and Supabase passwords, and tables.toml decides what is read from the ERP).
icacls "$dir" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /T /Q | Out-Null
Write-Host "Folder locked down: only SYSTEM and Administrators can access $dir"

# 2. Scheduled task
$action   = New-ScheduledTaskAction -Execute "$dir\run_agent.bat" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
    -User "SYSTEM" -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $name

Write-Host "Installed and started '$name'. Logs: $dir\logs\agent.log"
Write-Host "To remove: Unregister-ScheduledTask -TaskName '$name' -Confirm:`$false"
