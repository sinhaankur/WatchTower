@echo off
setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%install_windows.ps1"

if not exist "%PS_SCRIPT%" (
  echo Could not find install_windows.ps1 in %SCRIPT_DIR%
  exit /b 1
)

:: ── Check if PowerShell 7 (pwsh) is available ─────────────────────────────────
where pwsh >nul 2>&1
if %errorlevel% EQU 0 (
  echo PowerShell 7 found. Running installer...
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
  exit /b %errorlevel%
)

echo PowerShell 7 (pwsh) is not installed.
echo Attempting to install PowerShell 7 automatically...
echo.

:: ── Try winget (available on Windows 10 1709+ and Windows 11) ─────────────────
where winget >nul 2>&1
if %errorlevel% EQU 0 (
  echo Installing via winget...
  winget install --id Microsoft.PowerShell --source winget --accept-package-agreements --accept-source-agreements
  goto :check_pwsh
)

:: ── Try Chocolatey ────────────────────────────────────────────────────────────
where choco >nul 2>&1
if %errorlevel% EQU 0 (
  echo Installing via Chocolatey...
  choco install powershell-core -y
  goto :check_pwsh
)

:: ── Direct MSI download via Windows PowerShell 5 (always present) ─────────────
echo Neither winget nor choco found. Downloading PowerShell installer...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$url = 'https://github.com/PowerShell/PowerShell/releases/download/v7.4.2/PowerShell-7.4.2-win-x64.msi';" ^
  "$dest = \"$env:TEMP\PowerShell-7.4.2-win-x64.msi\";" ^
  "Write-Host 'Downloading PowerShell 7.4.2...';" ^
  "Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing;" ^
  "Write-Host 'Installing (silent)...';" ^
  "Start-Process msiexec.exe -Wait -ArgumentList \"/package $dest /quiet /norestart ADD_EXPLORER_CONTEXT_MENU_OPENPOWERSHELL=1\";" ^
  "Remove-Item $dest -Force"

if %errorlevel% NEQ 0 (
  echo.
  echo Automatic download failed. Please install PowerShell 7 manually:
  echo   https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows
  echo.
  echo Then re-run this script.
  exit /b 1
)

:check_pwsh
:: Refresh PATH so the newly installed pwsh is found.
for /f "tokens=*" %%i in ('where pwsh 2^>nul') do set "PWSH_PATH=%%i"
if not defined PWSH_PATH (
  :: Common install location fallback.
  if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" (
    set "PWSH_PATH=%ProgramFiles%\PowerShell\7\pwsh.exe"
  )
)

if not defined PWSH_PATH (
  echo PowerShell 7 installation succeeded but pwsh was not found in PATH.
  echo Please open a NEW command prompt and re-run this script.
  exit /b 1
)

echo PowerShell 7 ready. Running WatchTower installer...
"%PWSH_PATH%" -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
exit /b %errorlevel%
