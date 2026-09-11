@echo off
setlocal

rem ============================================================
rem  Story Studio one-click launcher
rem  First run: install deps -> start dev server -> open browser.
rem  The project root is the folder this .bat lives in (copy the whole folder together).
rem ============================================================

set "APP_DIR=%~dp0"
if not exist "%APP_DIR%\package.json" (
  echo [ERROR] story-studio project not found next to this .bat. Keep this file inside the project root.
  pause
  exit /b 1
)
cd /d "%APP_DIR%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found in PATH. Install Node.js 18+ first.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [First run] Installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your network and retry.
    pause
    exit /b 1
  )
)

rem Local CORS relay for the Web build (same script the settings page offers to
rem download). Fresh build wins over the tracked copy when dist-test exists.
rem Placed BEFORE the 5199 check so re-launching while the server runs still
rem tops up a missing relay window.
if exist "dist-test\flow\webRelay.js" node scripts/extract-relay.mjs >nul 2>nul
netstat -ano | findstr ":8788" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [INFO] Relay already listening on 8788 - skipping.
) else (
  start "Story Studio Relay" cmd /k node "%APP_DIR%scripts\story-studio-relay.mjs" 8788
  echo [INFO] Relay window opened on http://127.0.0.1:8788 - closing that window stops the relay.
)

rem Already running? Just open the browser.
netstat -ano | findstr ":5199" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [INFO] Story Studio already running on port 5199. Opening browser...
  start "" "http://localhost:5199/"
  exit /b 0
)

echo.
echo   Starting Story Studio at  http://localhost:5199/
echo   (This window IS the server. Close it or press Ctrl+C to stop.)
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:5199/"
call npm run dev -- --port 5199 --strictPort
pause
