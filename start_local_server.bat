@echo off
setlocal
cd /d "%~dp0"

python -c "import sys" >nul 2>&1
if errorlevel 1 (
  echo Python was not found on PATH.
  echo Install Python or start the site manually with your preferred local server.
  pause
  exit /b 1
)

start "" http://localhost:8000/
python -m http.server 8000
