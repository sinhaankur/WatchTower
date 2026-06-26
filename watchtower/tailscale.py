"""Tailscale integration helpers for WatchTower.

Used by the managed-database replication flow to:
  * Discover this machine's Tailscale IPv4 (for exposing the primary).
  * List tailnet peers (for the "add remote standby" node picker in the UI).

All functions are best-effort — they return None / [] rather than raising
when Tailscale is not installed or not connected, so callers can degrade
gracefully on machines without Tailscale.
"""
from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class TailscalePeer:
    hostname: str
    tailscale_ip: str
    online: bool
    os: str


def local_ip() -> str | None:
    """Return this machine's Tailscale IPv4 address, or None."""
    try:
        out = subprocess.check_output(
            ["tailscale", "ip", "-4"], text=True, timeout=5
        ).strip()
        return out or None
    except Exception:
        return None


def peers() -> list[TailscalePeer]:
    """Return all tailnet peers (online and offline)."""
    try:
        raw = subprocess.check_output(
            ["tailscale", "status", "--json"], text=True, timeout=5
        )
        data = json.loads(raw)
        result = []
        for _, v in data.get("Peer", {}).items():
            ips = v.get("TailscaleIPs", [])
            ipv4 = next((ip for ip in ips if "." in ip), None)
            if not ipv4:
                continue
            result.append(TailscalePeer(
                hostname=v.get("HostName", "unknown"),
                tailscale_ip=ipv4,
                online=v.get("Online", False),
                os=v.get("OS", "unknown"),
            ))
        return result
    except Exception as exc:
        logger.debug("tailscale peers unavailable: %s", exc)
        return []


def online_peers() -> list[TailscalePeer]:
    """Return only peers that are currently online."""
    return [p for p in peers() if p.online]
