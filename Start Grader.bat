@echo off
REM PDF Auto-Grader: one-click start on this Windows PC. Double-click this file.
REM It checks Node.js, installs and builds the app when needed, starts it on http://localhost:3000 and opens the browser.
REM Keep the window open while you grade; press Ctrl+C (or close the window) to stop.
setlocal
title PDF Auto-Grader
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 goto oldnode

node "%~dp0scripts\start-grader.mjs"
if errorlevel 1 goto failed
REM The grader runs until Ctrl+C; keep the window open so its messages stay readable.
echo.
echo The grader has stopped.
pause
exit /b 0

:nonode
echo.
echo  Node.js is not installed on this computer.
echo  1. Download the LTS version from https://nodejs.org (the big green button) and install it.
echo  2. Then double-click "Start Grader.bat" again.
echo.
pause
exit /b 1

:oldnode
echo.
echo  This Node.js is too old: the grader needs version 22.13 or newer.
echo  Download the LTS version from https://nodejs.org, install it, then double-click "Start Grader.bat" again.
echo.
pause
exit /b 1

:failed
echo.
echo  The grader could not start. Read the messages above, fix what they say, then try again.
echo.
pause
exit /b 1
