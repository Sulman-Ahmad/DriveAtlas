@echo off
rem Starts DriveAtlas with a visible log window (handy for troubleshooting).
rem For everyday use, double-click DriveAtlas.vbs instead.
cd /d "%~dp0app"
where node >nul 2>nul || (echo Node.js was not found. Install Node.js 22 or newer from https://nodejs.org and try again. & pause & exit /b 1)
node --disable-warning=ExperimentalWarning hub\main.mjs --open
pause
