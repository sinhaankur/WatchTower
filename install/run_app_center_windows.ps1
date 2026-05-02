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
        $key = $parts[0].Trim()
        $value = $parts[1].Trim()
        # Strip optional surrounding quotes to support KEY="value with spaces".
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [System.Environment]::SetEnvironmentVariable($key, $value, [System.EnvironmentVariableTarget]::Process)
    }
}

$port = if ($env:WATCHTOWER_PORT) { [int]$env:WATCHTOWER_PORT } else { 8000 }
$bindHost = if ($env:WATCHTOWER_BIND_HOST) { $env:WATCHTOWER_BIND_HOST } else { "127.0.0.1" }

& $venvPython -m watchtower.deploy_server serve --host $bindHost --port $port
