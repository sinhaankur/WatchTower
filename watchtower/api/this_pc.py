"""Plug-and-play "Use this PC as the server" endpoints.

The product goal is "turn a PC into a server + database with simple steps."
The biggest friction for the primary use case — deploying to your own
machine — is the manual node registration flow (host, SSH user, key, reload
command). None of that is needed for localhost: WatchTower already runs here,
so it can register the local machine as a deploy target in one click and run
deploy commands directly instead of over SSH.

This module exposes:

  GET  /api/this-pc/status        readiness probe (runtime + already-registered)
  POST /api/this-pc/use-as-server idempotently register localhost as a node

The registered node is marked ``provider="local"`` so the deploy path can
recognise it and skip SSH. It reuses the same OrgNode table every other
deploy target lives in, so the rest of the app (deployments, health, the
Servers list) treats it uniformly.
"""
from __future__ import annotations

import json
import logging
import os
import platform
import socket
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from watchtower.database import NodeStatus, OrgNode, get_db
from watchtower.api import util
from watchtower.api import audit as audit_log

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/this-pc", tags=["This PC"])

# Marker stored in OrgNode.provider so the deploy path and the UI can tell a
# local node from an SSH/remote one. Kept as a module constant so the deploy
# runner and tests reference the same string.
LOCAL_PROVIDER = "local"
LOCAL_HOST = "127.0.0.1"


def _detect_runtime() -> Dict[str, Any]:
    """Best-effort container-runtime detection. Never raises — a missing
    runtime is a 'not ready yet' state, not an error."""
    try:
        from watchtower.podman_runtime import runtime_status
        rt = runtime_status()
        return {
            "available": bool(rt.get("available")),
            "connected": bool(rt.get("connected")),
            "binary": rt.get("binary"),
            "version": rt.get("version"),
            "hint": rt.get("hint"),
        }
    except Exception as exc:  # noqa: BLE001 — detection must never 500 the page
        logger.warning("this-pc runtime detection failed: %s", exc)
        return {
            "available": False,
            "connected": False,
            "binary": None,
            "version": None,
            "hint": "Could not probe the local container runtime.",
        }


def _local_hostname() -> str:
    try:
        return socket.gethostname() or "this-pc"
    except Exception:  # noqa: BLE001
        return "this-pc"


def _local_deploy_root() -> Path:
    """Where local deploys land. The builder rsyncs each deploy here and (for
    container projects) bind-mounts it. Must be a real, writable directory —
    an empty remote_path would make rsync/bind-mount target '/'. Mirrors the
    data-dir convention used elsewhere (WATCHTOWER_DATA_DIR → ~/.watchtower).
    """
    base = os.getenv("WATCHTOWER_DATA_DIR")
    root = Path(base).expanduser() if base else (Path.home() / ".watchtower")
    return root / "deployments" / "this-pc"


def _find_local_node(db: Session, org_id) -> Optional[OrgNode]:
    """The single local node for this org, if already registered."""
    return (
        db.query(OrgNode)
        .filter(OrgNode.org_id == org_id, OrgNode.provider == LOCAL_PROVIDER)
        .first()
    )


@router.get("/status")
async def this_pc_status(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> Dict[str, Any]:
    """Is this machine ready to be (or already) a deploy target?

    The UI uses this to render the one-click card: whether a local node is
    already registered, and whether the container runtime is ready so the
    button can say "Use this PC" vs. "Install Podman first".
    """
    from watchtower.api import enterprise

    _user, org, _member = enterprise._ensure_user_org_member(db, current_user)
    existing = _find_local_node(db, org.id)
    runtime = _detect_runtime()

    # "ready" = a runtime is installed. Deploys can still be queued without a
    # connected machine (it may just need starting), but a registerable node
    # needs at least the binary present.
    ready = runtime["available"]

    return {
        "hostname": _local_hostname(),
        "os": platform.system(),
        "arch": platform.machine(),
        "registered": existing is not None,
        "node_id": str(existing.id) if existing else None,
        "node_status": existing.status.value if existing else None,
        "runtime": runtime,
        "ready": ready,
    }


@router.post("/use-as-server", status_code=status.HTTP_200_OK)
async def use_this_pc_as_server(
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> Dict[str, Any]:
    """Register the local machine as a deploy target — one click, no SSH.

    Idempotent: calling it again returns the existing local node rather than
    creating a duplicate. Requires the node-management permission, same as
    adding a remote server.
    """
    from watchtower.api import enterprise

    user_id = enterprise._current_user_uuid(current_user)
    _user, org, member = enterprise._ensure_user_org_member(db, current_user)

    if not member or not member.can_manage_nodes:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You don't have permission to manage deployment servers.",
        )

    existing = _find_local_node(db, org.id)
    if existing:
        # Already set up — re-probe the runtime so the status is fresh, but
        # don't create a second local node.
        return {"node": _serialize(existing), "created": False}

    runtime = _detect_runtime()

    # Resolve (and create) the local deploy directory now so the node carries
    # a valid remote_path — the builder rsyncs here and bind-mounts it for
    # container projects. An empty path would target '/'.
    deploy_root = _local_deploy_root()
    try:
        deploy_root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.warning("Could not create local deploy dir %s: %s", deploy_root, exc)

    node = OrgNode(
        org_id=org.id,
        name=f"This PC ({_local_hostname()})",
        host=LOCAL_HOST,
        user="",                       # no SSH user — runs locally
        port=0,                        # not an SSH node
        remote_path=str(deploy_root),  # local deploy workdir (rsync + bind-mount target)
        reload_command="",             # local runner manages restarts
        provider=LOCAL_PROVIDER,
        is_primary=True,               # the obvious default target on a fresh install
        is_active=True,
        status=NodeStatus.HEALTHY if runtime["available"] else NodeStatus.OFFLINE,
        status_message=(
            "Local machine — ready"
            if runtime["available"]
            else "Local machine registered; install Podman or Docker to deploy containers."
        ),
        created_by_user_id=user_id,
        updated_by_user_id=user_id,
    )

    try:
        db.add(node)
        audit_log.record_for_user(
            db,
            current_user,
            action="node.use_this_pc",
            entity_type="org_node",
            entity_id=node.id,
            org_id=org.id,
            request=request,
            extra={"host": LOCAL_HOST, "provider": LOCAL_PROVIDER},
        )
        db.commit()
        db.refresh(node)
    except Exception:
        db.rollback()
        logger.exception("Failed to register local node")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not register this PC as a server.",
        )

    return {"node": _serialize(node), "created": True}


def _serialize(node: OrgNode) -> Dict[str, Any]:
    return {
        "id": str(node.id),
        "name": node.name,
        "host": node.host,
        "provider": node.provider,
        "is_primary": node.is_primary,
        "is_active": node.is_active,
        "status": node.status.value if node.status else None,
        "status_message": node.status_message,
    }


# ── Tailnet node discovery ───────────────────────────────────────────────────


# Default port the WatchTower API listens on. A peer answering /health here
# with our service marker is a control-plane standby candidate.
_WATCHTOWER_PORT = int(os.getenv("WATCHTOWER_PEER_PORT", "8000"))


def _peer_runs_watchtower(ip: str) -> bool:
    """Probe http://<ip>:<port>/health for the WatchTower service marker.

    Short timeout, best-effort: a peer that doesn't answer or isn't WatchTower
    just isn't a standby candidate. Never raises."""
    import urllib.request

    url = f"http://{ip}:{_WATCHTOWER_PORT}/health"
    try:
        with urllib.request.urlopen(url, timeout=2.0) as resp:  # noqa: S310 - tailnet IP, http on LAN
            if resp.status != 200:
                return False
            body = resp.read(512).decode("utf-8", "ignore")
        return "watchtower-api" in body
    except Exception:  # noqa: BLE001 - unreachable / not-watchtower / timeout
        return False


def _discover_tailnet_peers() -> List[Dict[str, Any]]:
    """Parse `tailscale status --json` into reachable peer candidates.

    Returns one entry per online peer (excluding this machine): hostname, the
    first Tailscale IP, and online state. Best-effort — returns [] if the
    Tailscale CLI isn't found or the call fails, so the endpoint never errors
    just because Tailscale isn't set up.
    """
    try:
        from watchtower.tool_resolver import tailscale_binary
        bin_ = tailscale_binary()
    except Exception:  # noqa: BLE001
        bin_ = None
    if not bin_:
        return []
    try:
        proc = subprocess.run(
            [bin_, "status", "--json"],
            capture_output=True, text=True, timeout=8.0,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.info("discover-nodes: tailscale status failed (%s)", exc)
        return []
    if proc.returncode != 0 or not (proc.stdout or "").strip():
        return []
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return []

    peers = (data.get("Peer") or {}).values()
    out: List[Dict[str, Any]] = []
    for p in peers:
        ips = p.get("TailscaleIPs") or []
        ip = ips[0] if ips else None
        if not ip:
            continue
        dns = (p.get("DNSName") or "").rstrip(".")
        host_label = (p.get("HostName") or dns or ip)
        online = bool(p.get("Online"))
        out.append({
            "hostname": host_label,
            "dns_name": dns or None,
            "ip": ip,
            "online": online,
            "os": p.get("OS") or None,
            # Only probe online peers — flags those running WatchTower as
            # control-plane standby candidates.
            "runs_watchtower": _peer_runs_watchtower(ip) if online else False,
        })
    # Online peers first, then alphabetical — most-useful candidates on top.
    out.sort(key=lambda c: (not c["online"], c["hostname"].lower()))
    return out


@router.get("/discover-nodes")
async def discover_nodes(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> Dict[str, Any]:
    """List machines on this Tailnet as one-click deploy-target candidates.

    Flags peers already registered as OrgNodes (by host == IP or DNS name) so
    the UI can disable "add" for them. Tailscale-only for now (it's the
    appliance's transport); returns an empty list cleanly when Tailscale isn't
    available."""
    peers = _discover_tailnet_peers()

    # Org resolution is best-effort: discovery is a read-only listing any
    # authenticated user can do. If the caller has no org (e.g. owner-mode
    # blocks a non-member), we still return the peers — just without the
    # already-added flag, rather than 403-ing on a harmless list.
    known_hosts: set[str] = set()
    try:
        from watchtower.api import enterprise
        _user, org, _member = enterprise._ensure_user_org_member(db, current_user)
        existing = db.query(OrgNode).filter(OrgNode.org_id == org.id).all()
        known_hosts = {(n.host or "").strip().lower() for n in existing}
    except Exception:  # noqa: BLE001 — flagging is a nicety, not load-bearing
        pass

    for c in peers:
        candidates = {c["ip"].lower()}
        if c.get("dns_name"):
            candidates.add(c["dns_name"].lower())
        c["already_added"] = bool(candidates & known_hosts)

    return {"source": "tailscale", "peers": peers}


# ── Control-plane HA pairing (primary / standby) ─────────────────────────────
#
# WatchTower can pair two control planes for failover: one PRIMARY, one
# STANDBY. v1 is detect-and-record: we discover a peer running WatchTower and,
# on operator approval, record the role + paired peer. This makes the topology
# explicit and visible. Automated state replication + automatic failover
# orchestration is a deliberate follow-up — we DON'T claim it here.

_ROLE_KEY = "control_plane.role"           # standalone | primary | standby
_PEER_HOST_KEY = "control_plane.peer_host"
_PEER_NAME_KEY = "control_plane.peer_name"
_PEER_PORT_KEY = "control_plane.peer_port"
_PEER_TOKEN_KEY = "control_plane.peer_token"   # secret: primary's API token (standby pulls with it)
_LAST_SYNC_KEY = "control_plane.last_synced_at"
_LAST_SYNC_ERROR_KEY = "control_plane.last_sync_error"
_VALID_ROLES = {"standalone", "primary", "standby"}


def _read_cp_pairing(db: Session) -> Dict[str, Any]:
    from watchtower.llm_settings import get_setting
    role = get_setting(db, _ROLE_KEY) or "standalone"
    return {
        "role": role if role in _VALID_ROLES else "standalone",
        "peer_host": get_setting(db, _PEER_HOST_KEY),
        "peer_name": get_setting(db, _PEER_NAME_KEY),
        "peer_port": int(get_setting(db, _PEER_PORT_KEY) or _WATCHTOWER_PORT),
        # Never echo the token; just whether one is stored (so standby can sync).
        "has_peer_token": bool(get_setting(db, _PEER_TOKEN_KEY)),
        "last_synced_at": get_setting(db, _LAST_SYNC_KEY),
        "last_sync_error": get_setting(db, _LAST_SYNC_ERROR_KEY),
    }


class CpPairRequest(BaseModel):
    role: str            # the role to assign THIS node: 'primary' or 'standby'
    peer_host: str       # the other node's host/IP (must run WatchTower)
    peer_name: Optional[str] = None
    peer_port: Optional[int] = None
    # When THIS node is the standby, it needs the primary's API token to pull
    # the primary's state export. Stored Fernet-encrypted, never echoed back.
    peer_token: Optional[str] = None


@router.get("/control-plane")
async def control_plane_status(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> Dict[str, Any]:
    """This node's control-plane role + paired peer + standby snapshot facts."""
    out = _read_cp_pairing(db)
    try:
        from watchtower import control_plane_sync
        out.update(control_plane_sync.snapshot_status())
    except Exception:  # noqa: BLE001 - snapshot facts are a nicety
        pass
    return out


@router.post("/control-plane/sync-now")
async def control_plane_sync_now(
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> Dict[str, Any]:
    """On-demand pull of the primary's state snapshot (standby only).

    Admin-gated. Returns the sync result + refreshed status. The scheduled tick
    does this automatically; this is the 'don't wait for the next tick' button.
    """
    from watchtower.api.runtime import _user_can_manage_org_secrets
    if not _user_can_manage_org_secrets(db, current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Syncing control-plane state requires can_manage_team permission.",
        )
    pairing = _read_cp_pairing(db)
    if pairing["role"] != "standby":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only a standby can pull state from the primary.",
        )
    from watchtower import control_plane_sync
    ok, message = control_plane_sync.sync_now()
    audit_log.record_for_user(
        db, current_user,
        action="control_plane.sync",
        entity_type="control_plane",
        request=request,
        extra={"ok": ok},
    )
    # sync_now committed its own settings; re-read for fresh status.
    db.expire_all()
    result = _read_cp_pairing(db)
    try:
        from watchtower import control_plane_sync as cps
        result.update(cps.snapshot_status())
    except Exception:  # noqa: BLE001
        pass
    return {"ok": ok, "message": message, "status": result}


@router.post("/control-plane/pair")
async def control_plane_pair(
    body: CpPairRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> Dict[str, Any]:
    """Record a primary/standby pairing with a discovered WatchTower peer.

    Detect-and-suggest: the UI offers this after finding a peer running
    WatchTower; the operator approves. Admin-gated (can_manage_team) since it
    changes the installation's HA topology. Idempotent — re-pairing overwrites.
    """
    from watchtower.api.runtime import _user_can_manage_org_secrets
    from watchtower.llm_settings import set_setting

    if not _user_can_manage_org_secrets(db, current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Pairing control planes requires can_manage_team permission.",
        )
    role = (body.role or "").strip().lower()
    if role not in {"primary", "standby"}:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="role must be 'primary' or 'standby'.",
        )
    peer_host = (body.peer_host or "").strip()
    if not peer_host:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="peer_host is required.",
        )

    user_id = None
    try:
        from watchtower.api import enterprise
        user_id = enterprise._current_user_uuid(current_user)
    except Exception:  # noqa: BLE001
        pass

    set_setting(db, _ROLE_KEY, role, user_id=user_id)
    set_setting(db, _PEER_HOST_KEY, peer_host, user_id=user_id)
    set_setting(db, _PEER_NAME_KEY, body.peer_name or peer_host, user_id=user_id)
    set_setting(db, _PEER_PORT_KEY, str(body.peer_port or _WATCHTOWER_PORT), user_id=user_id)
    if body.peer_token:
        set_setting(db, _PEER_TOKEN_KEY, body.peer_token, secret=True, user_id=user_id)
    # New pairing invalidates any prior sync state.
    set_setting(db, _LAST_SYNC_KEY, None)
    set_setting(db, _LAST_SYNC_ERROR_KEY, None)

    org_id = None
    try:
        from watchtower.api import enterprise
        _u, org, _m = enterprise._ensure_user_org_member(db, current_user)
        org_id = org.id
    except Exception:  # noqa: BLE001
        pass
    audit_log.record_for_user(
        db, current_user,
        action="control_plane.pair",
        entity_type="control_plane",
        org_id=org_id,
        request=request,
        extra={"role": role, "peer_host": peer_host, "peer_name": body.peer_name},
    )
    db.commit()
    if org_id is not None:
        try:
            from watchtower.notifier import notify_org
            notify_org(
                db, org_id,
                f"🔗 Control-plane paired: this node is now **{role}**, "
                f"linked with **{body.peer_name or peer_host}**.",
            )
        except Exception:  # noqa: BLE001 - notify must not fail the pairing
            pass
    return _read_cp_pairing(db)


@router.post("/control-plane/unpair")
async def control_plane_unpair(
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> Dict[str, Any]:
    """Tear down the pairing — back to standalone. Admin-gated."""
    from watchtower.api.runtime import _user_can_manage_org_secrets
    from watchtower.llm_settings import set_setting

    if not _user_can_manage_org_secrets(db, current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Changing control-plane pairing requires can_manage_team permission.",
        )
    for k in (_ROLE_KEY, _PEER_HOST_KEY, _PEER_NAME_KEY, _PEER_PORT_KEY,
              _PEER_TOKEN_KEY, _LAST_SYNC_KEY, _LAST_SYNC_ERROR_KEY):
        set_setting(db, k, None)
    audit_log.record_for_user(
        db, current_user,
        action="control_plane.unpair",
        entity_type="control_plane",
        request=request,
    )
    db.commit()
    try:
        from watchtower.api import enterprise
        from watchtower.notifier import notify_org
        _u, org, _m = enterprise._ensure_user_org_member(db, current_user)
        notify_org(db, org.id, "🔓 Control-plane unpaired — this node is now standalone.")
    except Exception:  # noqa: BLE001 - notify must not fail the unpair
        pass
    return _read_cp_pairing(db)


# ── Guided SSH setup ─────────────────────────────────────────────────────────


@router.get("/ssh-key")
async def get_managed_ssh_key(
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> Dict[str, Any]:
    """Return WatchTower's managed deploy public key (generating it on first
    use), plus the private-key path to register on a node and a copy-paste
    one-liner to authorize it on the remote host.

    Only the PUBLIC key is ever returned — the private key stays on this host.
    """
    from watchtower import ssh_setup

    ok, message = ssh_setup.ensure_keypair()
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Could not prepare an SSH key: {message}",
        )
    pubkey = ssh_setup.read_public_key()
    if not pubkey:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="SSH key was created but the public key could not be read.",
        )
    return {
        "public_key": pubkey,
        "private_key_path": str(ssh_setup.private_key_path()),
        "authorize_command": ssh_setup.authorized_keys_oneliner(pubkey),
    }
