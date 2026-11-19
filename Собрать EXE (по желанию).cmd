@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Install Python 3.11 from python.org to build a Windows EXE.
  pause
  exit /b 1
)
py -3.11 -m pip install --upgrade pyinstaller
if errorlevel 1 (
  echo PyInstaller installation failed.
  pause
  exit /b 1
)
py -3.11 -m PyInstaller --noconfirm --clean --onefile --windowed --name "Sredstvo3D" --add-data "docs;docs" --add-data "worker.py;." desktop.py
if errorlevel 1 (
  echo Build failed. Check errors above.
  pause
  exit /b 1
)
echo.
echo Windows app: dist\Sredstvo3D.exe
echo You can double-click this EXE to start the local server and desktop window.
pause
