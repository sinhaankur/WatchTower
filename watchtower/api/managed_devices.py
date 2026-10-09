"""Managed devices — operate your OTHER WatchTower boxes from one console.

The VMware-style "single pane of glass": from this WatchTower you pair any
number of remote WatchTower devices on your Tailscale tailnet, then view and
(later) control them inline. Each device carries its own API token so a call
to it is authenticated as that box's operator — we never invent new authority,
we just hold a credential you already own and proxy with it.

Storage: devices live in the existing SystemSettings key-value store (same
place control-plane pairing persists), so there's no schema migration. Each
device is a small set of keys under ``managed_device.<id>.*`` and the token is
stored ``secret=True`` (Fernet-encrypted at rest, never echoed back). An index
key holds the list of device ids.

Security:
  • admin-gated (can_manage_team) — pairing/unpairing changes what this box
    can command.
  • the device IP must be a Tailscale CGNAT address (100.64.0.0/10 /
    fd7a:115c:a1e0::/48) so a paired device can only ever be on your tailnet,
    not an arbitrary internet host (SSRF guard).
  • the token is only ever sent to the device it belongs to, over the tailnet.
"""
from __future__ import annotations

import ipaddress
import json
import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.database import get_db
from watchtower.llm_settings import get_setting, set_setting

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/managed-devices", tags=["Managed Devices"])

_INDEX_KEY = "managed_devices.index"          # JSON list of device ids
_DEFAULT_PORT = 8000


# ── IP validation (tailnet only) ─────────────────────────────────────────────

_TS_V4 = ipaddress.ip_network("100.64.0.0/10")
_TS_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")


def _is_tailnet_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv4Address):
        return addr in _TS_V4
    return addr in _TS_V6


# ── Registry (SystemSettings-backed, no migration) ───────────────────────────


def _device_key(device_id: str, field: str) -> str:
    return f"managed_device.{device_id}.{field}"


def _read_index(db: Session) -> List[str]:
    raw = get_setting(db, _INDEX_KEY)
    if not raw:
        return []
    try:
        ids = json.loads(raw)
        return [str(i) for i in ids] if isinstance(ids, list) else []
    except (ValueError, TypeError):
        return []


def _write_index(db: Session, ids: List[str], user_id=None) -> None:
    set_setting(db, _INDEX_KEY, json.dumps(ids), user_id=user_id)


def _read_device(db: Session, device_id: str) -> Optional[Dict[str, Any]]:
    name = get_setting(db, _device_key(device_id, "name"))
    ip = get_setting(db, _device_key(device_id, "ip"))
    if not ip:
        return None
    return {
        "id": device_id,
        "name": name or ip,
        "ip": ip,
        "port": int(get_setting(db, _device_key(device_id, "port")) or _DEFAULT_PORT),
        # Never surface the token itself — only whether one is on file.
        "has_token": bool(get_setting(db, _device_key(device_id, "token"))),
    }


def _device_token(db: Session, device_id: str) -> Optional[str]:
    """Decrypt + return a device's stored API token (get_setting already
    decrypts secret rows)."""
    return get_setting(db, _device_key(device_id, "token"))


def _delete_device(db: Session, device_id: str, user_id=None) -> None:
    for field in ("name", "ip", "port", "token"):
        set_setting(db, _device_key(device_id, field), None)  # None deletes
    ids = [i for i in _read_index(db) if i != device_id]
    _write_index(db, ids, user_id=user_id)


# ── Schemas ──────────────────────────────────────────────────────────────────


class DeviceResponse(BaseModel):
    id: str
    name: str
    ip: str
    port: int
    has_token: bool


class PairRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    ip: str = Field(..., min_length=1, max_length=64)
    port: int = Field(_DEFAULT_PORT, ge=1, le=65535)
    # The remote device's API token. Stored Fernet-encrypted, never echoed.
    token: str = Field(..., min_length=1, max_length=512)


# ── Auth guard ───────────────────────────────────────────────────────────────


def _require_admin(db: Session, current_user: dict) -> None:
    from watchtower.api.runtime import _user_can_manage_org_secrets
    if not _user_can_manage_org_secrets(db, current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Managing paired devices requires can_manage_team permission.",
        )


# ── Routes ───────────────────────────────────────────────────────────────────


@router.get("", response_model=List[DeviceResponse])
async def list_devices(
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> List[DeviceResponse]:
    out: List[DeviceResponse] = []
    for device_id in _read_index(db):
        dev = _read_device(db, device_id)
        if dev:
            out.append(DeviceResponse(**dev))
    return out


@router.post("", response_model=DeviceResponse)
async def pair_device(
    body: PairRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> DeviceResponse:
    """Pair a remote WatchTower device so it can be operated from this console.

    The device's token is stored encrypted and used to authenticate proxied
    calls to it. Admin-gated; the IP must be on your tailnet."""
    _require_admin(db, current_user)

    ip = body.ip.strip()
    if not _is_tailnet_ip(ip):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Device IP must be a Tailscale address (100.64.0.0/10). "
                   "You can only pair devices on your own tailnet.",
        )

    user_id = None
    try:
        from watchtower.api import enterprise
        user_id = enterprise._current_user_uuid(current_user)
    except Exception:  # noqa: BLE001
        pass

    # Re-pair by IP: if a device with this IP already exists, update it in
    # place rather than creating a duplicate.
    existing_id = None
    for did in _read_index(db):
        if get_setting(db, _device_key(did, "ip")) == ip:
            existing_id = did
            break
    device_id = existing_id or uuid.uuid4().hex

    set_setting(db, _device_key(device_id, "name"), body.name.strip(), user_id=user_id)
    set_setting(db, _device_key(device_id, "ip"), ip, user_id=user_id)
    set_setting(db, _device_key(device_id, "port"), str(body.port), user_id=user_id)
    set_setting(db, _device_key(device_id, "token"), body.token, secret=True, user_id=user_id)
    if existing_id is None:
        _write_index(db, _read_index(db) + [device_id], user_id=user_id)

    audit_log.record_for_user(
        db, current_user,
        action="managed_device.pair",
        entity_type="managed_device",
        request=request,
        # Host is fine to log; the token never is.
        extra={"name": body.name.strip(), "ip": ip, "port": body.port, "repair": existing_id is not None},
    )
    db.commit()
    dev = _read_device(db, device_id)
    assert dev is not None
    return DeviceResponse(**dev)


# ── Cross-device read proxy (VMware-style inline view) ───────────────────────
#
# Forward a whitelisted READ call to a paired device, authenticated with that
# device's own token, and return its JSON verbatim. Read-only and allow-listed
# by design: this console can SEE a remote box's projects / containers /
# deploys / health, but the proxy will not forward anything that isn't on the
# list — so it can't be turned into a general remote-command channel.

# path → the upstream API path on the device. Keep this tight; add entries
# deliberately as inline views are built.
_PROXY_READS: Dict[str, str] = {
    "projects": "/api/projects",
    "containers": "/api/podman/containers",
    "deployments": "/api/deployments",
    "health": "/health",
    "me": "/api/me",
}


def _proxy_get(ip: str, port: int, upstream_path: str, token: str, *, timeout: float = 6.0) -> tuple[int, Any]:
    """GET http://<ip>:<port><upstream_path> with Bearer <token>. Returns
    (status_code, parsed_json_or_text). Never raises — upstream problems come
    back as a 502-ish tuple the caller renders."""
    import urllib.error
    import urllib.request

    url = f"http://{ip}:{port}{upstream_path}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - tailnet IP
            body = resp.read(1_000_000).decode("utf-8", "ignore")
            code = resp.status
    except urllib.error.HTTPError as exc:
        body = exc.read(4096).decode("utf-8", "ignore") if exc.fp else ""
        code = exc.code
    except Exception as exc:  # noqa: BLE001 - unreachable / timeout
        return (502, {"detail": f"Could not reach device: {exc}"})
    try:
        return (code, json.loads(body))
    except (ValueError, TypeError):
        return (code, {"raw": body})


@router.get("/{device_id}/view/{view}")
async def proxy_device_view(
    device_id: str,
    view: str,
    db: Session = Depends(get_db),
    _current_user: dict = Depends(util.get_current_user),
) -> Dict[str, Any]:
    """Read a paired device's resource inline (projects/containers/deploys/…).

    Allow-listed read-only proxy — see ``_PROXY_READS``. The device's token is
    used to authenticate upstream; it never leaves this server."""
    upstream = _PROXY_READS.get(view)
    if upstream is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown view '{view}'. Allowed: {', '.join(sorted(_PROXY_READS))}.",
        )
    dev = _read_device(db, device_id)
    if dev is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    if not _is_tailnet_ip(dev["ip"]):
        # Defensive: a stored device should always be a tailnet IP, but never
        # proxy to a non-tailnet address even if the store were tampered with.
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Device IP is not on the tailnet.")
    token = _device_token(db, device_id)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No token stored for this device — re-pair it to view its resources.",
        )
    code, payload = _proxy_get(dev["ip"], dev["port"], upstream, token)
    return {"device_id": device_id, "view": view, "status": code, "data": payload}


@router.delete("/{device_id}")
async def unpair_device(
    device_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> Dict[str, Any]:
    _require_admin(db, current_user)
    dev = _read_device(db, device_id)
    if dev is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found")
    _delete_device(db, device_id)
    audit_log.record_for_user(
        db, current_user,
        action="managed_device.unpair",
        entity_type="managed_device",
        request=request,
        extra={"name": dev["name"], "ip": dev["ip"]},
    )
    db.commit()
    return {"ok": True, "id": device_id}
