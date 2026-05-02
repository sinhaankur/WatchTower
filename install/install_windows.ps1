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

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir
$venvDir = Join-Path $InstallDir ".venv"
$venvPython = Join-Path $venvDir "Scripts\python.exe"

# ── Detect existing installation ───────────────────────────────────────────────
$existingVersion = $null
if (Test-Path $venvPython) {
    try {
        $existingVersion = & $venvPython -c "import importlib.metadata; print(importlib.metadata.version('watchtower'))" 2>$null
    } catch { $existingVersion = $null }
}

if ($existingVersion) {
    Write-Host ""
    Write-Host "[install] WatchTower $existingVersion is already installed at $InstallDir."

    # Stop any scheduled task that may be running the old version.
    $taskName = "WatchTowerAppCenter"
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq "Running") {
        Write-Host "[install] Stopping scheduled task '$taskName' before update…"
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }

    # Kill any running WatchTower python process to free file locks.
    # Get-Process.CommandLine is inconsistent across PS editions; query via CIM.
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
             Where-Object {
                ($_.Name -match '^python(\.exe)?$') -and
                ($_.CommandLine -like "*watchtower*")
             }
    if ($procs) {
        Write-Host "[install] Stopping running WatchTower process(es)…"
        $procs | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }

    Write-Host "[install] Updating in-place — config files in $ConfigDir are preserved."
    Write-Host ""
} else {
    Write-Host "[install] No existing installation found — performing fresh install."
    Write-Host ""
}

# ── Install ────────────────────────────────────────────────────────────────────

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null

Write-Host "Copying project files..."
robocopy $repoDir $InstallDir /E /XD .git .venv __pycache__ | Out-Null

Write-Host "Creating virtual environment..."
python -m venv $venvDir

Write-Host "Installing WatchTower..."
& $venvPython -m pip install --upgrade pip -q
& $venvPython -m pip install $InstallDir -q

$nodesPath = Join-Path $ConfigDir "nodes.json"
$appsPath = Join-Path $ConfigDir "apps.json"
$envPath = Join-Path $ConfigDir "appcenter.env"

if (-not (Test-Path $nodesPath)) {
    Copy-Item (Join-Path $InstallDir "config\nodes.json") $nodesPath
}
if (-not (Test-Path $appsPath)) {
    Copy-Item (Join-Path $InstallDir "config\apps.json") $appsPath
}
if (-not (Test-Path $envPath)) {
    $triggerToken = & $venvPython -c "import secrets; print(secrets.token_urlsafe(32))"
    $envLines = @(
        "WATCHTOWER_REPO_DIR=$InstallDir",
        "WATCHTOWER_NODES_FILE=$nodesPath",
        "WATCHTOWER_APPS_FILE=$appsPath",
        "WATCHTOWER_TRIGGER_TOKEN=$triggerToken",
        "WATCHTOWER_DEFAULT_BRANCH=main",
        "WATCHTOWER_LOG_LEVEL=INFO",
        "WATCHTOWER_PORT=$Port",
        "WATCHTOWER_BIND_HOST=127.0.0.1"
    )
    $envLines | Set-Content -Path $envPath -Encoding UTF8
}

# ── Re-start scheduled task if it existed ─────────────────────────────────────
$taskName = "WatchTowerAppCenter"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Write-Host "[install] Restarting scheduled task '$taskName'…"
    Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

$newVersion = & $venvPython -c "import importlib.metadata; print(importlib.metadata.version('watchtower'))" 2>$null

Write-Host ""
Write-Host "WatchTower App Center $newVersion — ready."
Write-Host "Run the API with:"
Write-Host "  powershell -ExecutionPolicy Bypass -File '$InstallDir\install\run_app_center_windows.ps1' -ConfigDir '$ConfigDir'"
Write-Host ""
Write-Host "Then test:"
Write-Host "  curl http://127.0.0.1:$Port/health"
