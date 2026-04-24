#!/usr/bin/env bash
set -euo pipefail

if command -v pwsh >/dev/null 2>&1; then
  echo "PowerShell already installed: $(pwsh --version)"
  exit 0
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo ./scripts/install-powershell-linux.sh"
  exit 1
fi

if [[ ! -f /etc/os-release ]]; then
  echo "Unsupported Linux distribution: missing /etc/os-release"
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
ID_LIKE="${ID_LIKE:-}"

install_deb() {
  local distro="${ID}"
  local version_major
  version_major="${VERSION_ID%%.*}"

  apt-get update
  apt-get install -y wget apt-transport-https software-properties-common gpg

  local repo_pkg="packages-microsoft-prod.deb"
  wget -q "https://packages.microsoft.com/config/${distro}/${version_major}/${repo_pkg}" -O "/tmp/${repo_pkg}"
  dpkg -i "/tmp/${repo_pkg}"
  rm -f "/tmp/${repo_pkg}"

  apt-get update
  apt-get install -y powershell
}

install_rpm() {
  local distro="${ID}"
  local version_major
  version_major="${VERSION_ID%%.*}"

  if command -v dnf >/dev/null 2>&1; then
    dnf install -y "https://packages.microsoft.com/config/${distro}/${version_major}/packages-microsoft-prod.rpm"
    dnf install -y powershell
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    yum install -y "https://packages.microsoft.com/config/${distro}/${version_major}/packages-microsoft-prod.rpm"
    yum install -y powershell
    return
  fi

  echo "No supported RPM package manager found (dnf/yum)."
  exit 1
}

case "${ID}" in
  ubuntu|debian)
    install_deb
    ;;
  fedora|rhel|rocky|almalinux)
    install_rpm
    ;;
  *)
    if [[ "${ID_LIKE}" == *"debian"* ]]; then
      install_deb
    elif [[ "${ID_LIKE}" == *"rhel"* || "${ID_LIKE}" == *"fedora"* ]]; then
      install_rpm
    else
      echo "Unsupported distribution: ${ID}"
      echo "Install manually: https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux"
      exit 1
    fi
    ;;
esac

if ! command -v pwsh >/dev/null 2>&1; then
  echo "PowerShell installation failed."
  exit 1
fi

echo "Installed successfully: $(pwsh --version)"
