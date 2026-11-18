@echo off
setlocal
cd /d "%~dp0"
set NO_PROXY=localhost,127.0.0.1,::1
set no_proxy=localhost,127.0.0.1,::1
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" "app.py" --browser
) else (
  py -3.11 "app.py" --browser
)
pause
