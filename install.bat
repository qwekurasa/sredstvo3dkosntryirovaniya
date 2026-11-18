@echo off
setlocal
cd /d "%~dp0"
echo [Sredstvo 3D] Preparing local server...
where py >nul 2>nul
if %errorlevel%==0 (
  py -3.11 -m venv .venv
) else (
  python -m venv .venv
)
if not exist ".venv\Scripts\python.exe" (
  echo Python 3.11 is required. Install it and try again.
  pause
  exit /b 1
)
echo Ready! Start the studio with start-local.bat
pause
