@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node server.js
pause
