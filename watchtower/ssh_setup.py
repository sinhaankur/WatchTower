"""Guided SSH setup for remote deploy targets.

Removes the manual key dance. WatchTower keeps ONE managed deploy keypair per
install (ed25519, generated on first use, 0600 private key under the data dir).
The guided flow is:

  1. GET the managed public key  →  user pastes it into the remote's
     ~/.ssh/authorized_keys (we also give a copy-paste one-liner).
  2. Register the node with ssh_key_path pointed at the managed private key.
  3. The existing health check (builder.check_ssh_connectivity) confirms it.

No private key ever leaves the host; only the public key is returned.
"""
from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

_KEY_COMMENT = "watchtower-deploy"


def _data_dir() -> Path:
    base = os.getenv("WATCHTOWER_DATA_DIR")
    return Path(base).expanduser() if base else (Path.home() / ".watchtower")


def key_dir() -> Path:
    return _data_dir() / "ssh"


def private_key_path() -> Path:
    return key_dir() / "watchtower_deploy_ed25519"


def public_key_path() -> Path:
    return Path(str(private_key_path()) + ".pub")


def key_exists() -> bool:
    return private_key_path().is_file() and public_key_path().is_file()


def ensure_keypair() -> Tuple[bool, str]:
    """Generate the managed deploy keypair if absent. Returns (ok, message).

    Idempotent: if a key already exists it's reused. Uses ssh-keygen (present
    wherever ssh is) with no passphrase so unattended deploys work.
    """
    if key_exists():
        return True, "Managed deploy key already exists."

    kd = key_dir()
    try:
        kd.mkdir(parents=True, exist_ok=True)
        os.chmod(kd, 0o700)
    except OSError as exc:
        return False, f"Could not create key directory: {exc}"

    import shutil
    keygen = shutil.which("ssh-keygen")
    if not keygen:
        return False, "ssh-keygen not found on this host."

    try:
        proc = subprocess.run(
            [keygen, "-t", "ed25519", "-N", "", "-C", _KEY_COMMENT,
             "-f", str(private_key_path())],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"ssh-keygen failed to run: {exc}"
    if proc.returncode != 0:
        return False, (proc.stderr or "ssh-keygen failed").strip()[:300]

    try:
        os.chmod(private_key_path(), 0o600)
    except OSError:
        pass
    return True, "Generated a new managed deploy key."


def read_public_key() -> Optional[str]:
    try:
        return public_key_path().read_text(encoding="utf-8").strip()
    except OSError:
        return None


def authorized_keys_oneliner(pubkey: str) -> str:
    """A copy-paste command the user runs ON the remote host to authorize this
    key. Single-quoted so the key (which contains no single quotes) is safe."""
    return (
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh && "
        f"echo '{pubkey}' >> ~/.ssh/authorized_keys && "
        "chmod 600 ~/.ssh/authorized_keys"
    )
