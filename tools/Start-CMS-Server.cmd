@echo off
setlocal

REM ============================================================================
REM  CMS Warehouse - server launcher
REM
REM  Starts the WMS backend, which also serves the built frontend from
REM  frontend\dist on the same port, then opens the sign-in screen in a browser.
REM
REM  Run this on the machine acting as the CMS server. Other devices on the
REM  warehouse network reach it at http://<this-machine-ip>:<PORT> - see
REM  docs\WAREHOUSE_DEVICE_SETUP.md to install the app on those devices.
REM  (tools\CMS-Warehouse.cmd is the other script - it only opens a browser
REM  window pointed at a server that is already running elsewhere; it does not
REM  start anything.)
REM ============================================================================

cd /d "%~dp0..\backend"

if not exist ".env" (
  echo backend\.env is missing. Copy .env.example to .env and configure it first.
  pause
  exit /b 1
)

if not exist "..\frontend\dist\index.html" (
  echo No frontend build found.
  echo Run: npm run build --workspace @envo/wms-frontend
  pause
  exit /b 1
)

set PORT=
for /f "tokens=2 delims==" %%p in ('findstr /b /r "^PORT=" .env') do set PORT=%%p
if "%PORT%"=="" set PORT=5100

echo Starting EnVo WMS on port %PORT% ...
start "EnVo WMS Server" cmd /k node src\server.js

REM Give the server a moment to bind before opening the browser.
timeout /t 3 /nobreak >nul

start "" "http://localhost:%PORT%"

endlocal
