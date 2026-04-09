Param(
    [string]$InstallDir = "$env:USERPROFILE\WatchTowerAppCenter",
    [string]$ConfigDir = "$env:USERPROFILE\WatchTowerConfig"
)

$ErrorActionPreference = "Stop"

$venvPython = Join-Path $InstallDir ".venv\Scripts\python.exe"
$envPath = Join-Path $ConfigDir "appcenter.env"

if (-not (Test-Path $venvPython)) {
    throw "WatchTower is not installed at $InstallDir. Run install_windows.ps1 first."
}
if (-not (Test-Path $envPath)) {
    throw "Missing $envPath. Run install_windows.ps1 first."
}

Get-Content $envPath | ForEach-Object {
    if ($_ -match "^\s*#" -or $_ -match "^\s*$") { return }
    $parts = $_ -split "=", 2
    if ($parts.Length -eq 2) {
        [System.Environment]::SetEnvironmentVariable($parts[0], $parts[1])
    }
}

$port = if ($env:WATCHTOWER_PORT) { [int]$env:WATCHTOWER_PORT } else { 8000 }

& $venvPython -m watchtower.deploy_server serve --host 0.0.0.0 --port $port
