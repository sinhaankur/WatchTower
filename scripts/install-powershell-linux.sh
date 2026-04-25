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
  local distro="${1}"
  local version_id="${2}"
  local version_major="${version_id%%.*}"

  apt-get update -q
  apt-get install -y wget apt-transport-https software-properties-common gpg

  # Try the Microsoft package repo for the exact distro/version first.
  local repo_pkg="packages-microsoft-prod.deb"
  local repo_url="https://packages.microsoft.com/config/${distro}/${version_major}/${repo_pkg}"
  if wget -q --spider "${repo_url}" 2>/dev/null; then
    wget -q "${repo_url}" -O "/tmp/${repo_pkg}"
    dpkg -i "/tmp/${repo_pkg}"
    rm -f "/tmp/${repo_pkg}"
    apt-get update -q
    apt-get install -y powershell
  else
    # Fallback: snap (available on Ubuntu 18.04+) or direct .deb download.
    echo "Microsoft repo not found for ${distro} ${version_id}. Trying snap..."
    if command -v snap >/dev/null 2>&1; then
      snap install powershell --classic
    else
      echo "snap not available. Attempting direct .deb download for latest PowerShell..."
      local latest_deb
      latest_deb=$(wget -qO- https://api.github.com/repos/PowerShell/PowerShell/releases/latest \
        | grep "browser_download_url.*linux-x64.deb" | head -1 | cut -d '"' -f 4)
      if [[ -z "${latest_deb}" ]]; then
        echo "Could not resolve download URL. Install manually:"
        echo "  https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux"
        exit 1
      fi
      wget -q "${latest_deb}" -O /tmp/powershell.deb
      apt-get install -y /tmp/powershell.deb
      rm -f /tmp/powershell.deb
    fi
  fi
}

install_rpm() {
  local distro="${1}"
  local version_id="${2}"
  local version_major="${version_id%%.*}"

  local pm="dnf"
  command -v dnf >/dev/null 2>&1 || pm="yum"

  if ! command -v "${pm}" >/dev/null 2>&1; then
    echo "No supported RPM package manager found (dnf/yum)."
    exit 1
  fi

  local repo_rpm="https://packages.microsoft.com/config/${distro}/${version_major}/packages-microsoft-prod.rpm"
  if wget -q --spider "${repo_rpm}" 2>/dev/null; then
    "${pm}" install -y "${repo_rpm}"
    "${pm}" install -y powershell
  else
    echo "Microsoft repo not found for ${distro} ${version_major}. Attempting direct .rpm download..."
    local latest_rpm
    latest_rpm=$(wget -qO- https://api.github.com/repos/PowerShell/PowerShell/releases/latest \
      | grep "browser_download_url.*linux-x64.rpm" | head -1 | cut -d '"' -f 4)
    if [[ -z "${latest_rpm}" ]]; then
      echo "Could not resolve download URL. Install manually:"
      echo "  https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux"
      exit 1
    fi
    "${pm}" install -y "${latest_rpm}"
  fi
}

install_snap() {
  if command -v snap >/dev/null 2>&1; then
    snap install powershell --classic
  else
    echo "snap is not available on this system."
    echo "Install manually: https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-linux"
    exit 1
  fi
}

case "${ID}" in
  ubuntu|debian|linuxmint|pop|kali)
    install_deb "${ID}" "${VERSION_ID:-22}"
    ;;
  fedora|rhel|rocky|almalinux|centos)
    install_rpm "${ID}" "${VERSION_ID:-9}"
    ;;
  opensuse*|sles)
    # openSUSE: use snap or direct download
    install_snap
    ;;
  arch|manjaro|endeavouros)
    # Arch: install via AUR helper or direct binary
    if command -v yay >/dev/null 2>&1; then
      yay -S --noconfirm powershell-bin
    elif command -v paru >/dev/null 2>&1; then
      paru -S --noconfirm powershell-bin
    else
      echo "Arch Linux detected. Install powershell-bin via AUR:"
      echo "  yay -S powershell-bin"
      exit 1
    fi
    ;;
  *)
    if [[ "${ID_LIKE}" == *"debian"* ]]; then
      install_deb "${ID}" "${VERSION_ID:-22}"
    elif [[ "${ID_LIKE}" == *"rhel"* || "${ID_LIKE}" == *"fedora"* ]]; then
      install_rpm "${ID}" "${VERSION_ID:-9}"
    elif [[ "${ID_LIKE}" == *"arch"* ]]; then
      install_snap
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
