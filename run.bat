@echo off
REM Hanging Clozet — local launcher (static files + image link resolver)
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Opening index.html directly instead.
  start "" "index.html"
  exit /b 0
)

python server.py
