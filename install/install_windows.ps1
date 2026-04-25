Param(
    [string]$InstallDir = "$env:USERPROFILE\WatchTowerAppCenter",
    [string]$ConfigDir = "$env:USERPROFILE\WatchTowerConfig",
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"

Write-Host "Installing WatchTower App Center for Windows..."

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python is required. Install Python 3.8+ and re-run this script."
}

$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvDir = Join-Path $InstallDir ".venv"

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null

Write-Host "Copying project files..."
robocopy $repoDir $InstallDir /E /XD .git .venv __pycache__ | Out-Null

Write-Host "Creating virtual environment..."
python -m venv $venvDir

Write-Host "Installing WatchTower..."
& "$venvDir\Scripts\python.exe" -m pip install --upgrade pip
& "$venvDir\Scripts\python.exe" -m pip install $InstallDir

$nodesPath = Join-Path $ConfigDir "nodes.json"
$appsPath = Join-Path $ConfigDir "apps.json"
$envPath = Join-Path $ConfigDir "appcenter.env"

if (-not (Test-Path $nodesPath)) {
    Copy-Item (Join-Path $InstallDir "nodes.json") $nodesPath
}
if (-not (Test-Path $appsPath)) {
    Copy-Item (Join-Path $InstallDir "apps.json") $appsPath
}
if (-not (Test-Path $envPath)) {
    $triggerToken = & "$venvDir\Scripts\python.exe" -c "import secrets; print(secrets.token_urlsafe(32))"
@"
WATCHTOWER_REPO_DIR=$InstallDir
WATCHTOWER_NODES_FILE=$nodesPath
WATCHTOWER_APPS_FILE=$appsPath
WATCHTOWER_TRIGGER_TOKEN=$triggerToken
WATCHTOWER_DEFAULT_BRANCH=main
WATCHTOWER_LOG_LEVEL=INFO
WATCHTOWER_PORT=$Port
WATCHTOWER_BIND_HOST=127.0.0.1
"@ | Set-Content -Path $envPath -Encoding UTF8
}

Write-Host ""
Write-Host "WatchTower App Center installed."
Write-Host "Run the API with:"
Write-Host "  powershell -ExecutionPolicy Bypass -File run_app_center_windows.ps1 -ConfigDir '$ConfigDir'"
Write-Host ""
Write-Host "Then test:"
Write-Host "  curl http://127.0.0.1:$Port/health"
