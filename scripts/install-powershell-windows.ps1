$ErrorActionPreference = "Stop"

Write-Host "Installing PowerShell on Windows..."

if (Get-Command pwsh -ErrorAction SilentlyContinue) {
    pwsh --version
    Write-Host "PowerShell is already installed."
    exit 0
}

if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id Microsoft.PowerShell --source winget --accept-package-agreements --accept-source-agreements
}
elseif (Get-Command choco -ErrorAction SilentlyContinue) {
    choco install powershell-core -y
}
else {
    throw "Neither winget nor choco found. Install manually: https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows"
}

if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
    throw "PowerShell installation failed."
}

pwsh --version
Write-Host "PowerShell installed successfully."
