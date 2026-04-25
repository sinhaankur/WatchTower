@echo off
setlocal

set SCRIPT_DIR=%~dp0
set PS_SCRIPT=%SCRIPT_DIR%install_windows.ps1

if not exist "%PS_SCRIPT%" (
  echo Could not find install_windows.ps1 in %SCRIPT_DIR%
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
exit /b %errorlevel%
