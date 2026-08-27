@echo off
REM ============================================================================
REM  CMS Warehouse - desktop shortcut
REM
REM  A FALLBACK, not the normal way in. Installing the app from the browser
REM  (see docs\WAREHOUSE_DEVICE_SETUP.md) is better: it survives reboots, gets a
REM  Start-menu entry, and caches the app shell so it opens with no internet.
REM  Use this on a device that cannot install - an old browser, or a locked-down
REM  profile.
REM
REM  Opens the app in its own window with no address bar, using whichever of
REM  Edge or Chrome is on the machine.
REM
REM  SET THE ADDRESS BELOW to the CMS server on your warehouse network.
REM  Find it by running `ipconfig` on the CMS server machine.
REM ============================================================================

set CMS_URL=http://192.168.1.20:5100

REM --- Edge, in its two usual locations ---------------------------------------
set EDGE="%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist %EDGE% goto :launch_edge
set EDGE="%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist %EDGE% goto :launch_edge

REM --- Chrome ------------------------------------------------------------------
set CHROME="%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist %CHROME% goto :launch_chrome
set CHROME="%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist %CHROME% goto :launch_chrome

REM --- Neither found: fall back to the default browser -------------------------
echo Could not find Edge or Chrome. Opening in the default browser instead.
echo The app will work, but in an ordinary browser window.
start "" "%CMS_URL%"
goto :eof

:launch_edge
start "" %EDGE% --app=%CMS_URL%
goto :eof

:launch_chrome
start "" %CHROME% --app=%CMS_URL%
goto :eof
