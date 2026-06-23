"""Remote-access providers — expose WatchTower's UI/API over a private network or public tunnel.

Phase 1 ships Tailscale only. The provider abstraction (`_Provider`)
exists so Cloudflare Tunnel and raw SSH reverse tunnels can plug in
without changing the SPA contract or the route shape.

Why this exists: most users hit WatchTower over localhost. The moment
they want to use it from a phone, a coworker's laptop, or from outside
their network, they're stuck CLI-fiddling with ngrok / Tailscale / SSH
tunnels. The Remote Access page detects what's installed locally and
offers a one-click "expose port 8000" button per provider.

Security posture:
  * All endpoints require the standard auth dep (signed session OR static token).
  * Detection / status calls are read-only and run fast (sub-second).
  * Enable/disable shell out to the provider CLI under the operator's
    own UID — we never sudo, never elevate. If the underlying tool
    needs root (some Tailscale installs do), the operator gets the
    real stderr back so they can re-run with sudo themselves.
  * Audit log captures every enable/disable so it shows up alongside
    project/deployment actions.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
from dataclasses import dataclass
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from watchtower.api import audit as audit_log
from watchtower.api import util
from watchtower.database import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/remote-access", tags=["Remote Access"])


# ── Subprocess wrapper ───────────────────────────────────────────────────────
# Pulled into a module-level function so tests can monkeypatch a single
# symbol instead of every call site. Returns (returncode, stdout, stderr)
# and never raises for non-zero exits — providers parse the result.

def _run(cmd: list[str], *, timeout: float = 8.0) -> tuple[int, str, str]:
    """Run a command, return (rc, stdout, stderr). Never raises on non-zero."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return result.returncode, result.stdout or "", result.stderr or ""
    except FileNotFoundError:
        # Treat "binary missing" the same as a failed run — the provider's
        # detect() already covers the not-installed case, so this only
        # fires when something disappeared between detect() and enable().
        return 127, "", f"{cmd[0]}: not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"{cmd[0]}: timed out after {timeout}s"


# Tool resolution (incl. the macOS Tailscale GUI-bundle fallback) lives in
# watchtower.tool_resolver — one source of truth shared with runtime.py so
# "installed here, missing there" drift can't recur. Re-exported here under
# the name callers/tests already use.
from watchtower.tool_resolver import tailscale_binary  # noqa: E402,F401


# ── Provider abstraction ─────────────────────────────────────────────────────


@dataclass
class _ProviderState:
    """Public per-provider snapshot returned by GET /providers."""
    id: str                  # stable slug, e.g. "tailscale"
    name: str                # human label
    installed: bool          # binary present on PATH?
    ready: bool              # installed AND authenticated/usable
    sharing: bool            # actively exposing a port right now
    url: Optional[str]       # public/private URL when sharing
    detail: Optional[str]    # short status string for the UI
    hint: Optional[str]      # actionable hint when not ready
    install_url: Optional[str]  # where to download/install the agent


class _Provider:
    """Base class — subclasses implement detect/enable/disable."""
    id: str = ""
    name: str = ""
    install_url: Optional[str] = None

    def state(self) -> _ProviderState:  # pragma: no cover - abstract
        raise NotImplementedError

    def enable(self, port: int) -> _ProviderState:  # pragma: no cover - abstract
        raise NotImplementedError

    def disable(self) -> _ProviderState:  # pragma: no cover - abstract
        raise NotImplementedError


# ── Tailscale ────────────────────────────────────────────────────────────────


class TailscaleProvider(_Provider):
    """Tailscale Serve — exposes a local port over HTTPS within the user's tailnet.

    Reachable from any device signed into the same tailnet (phones,
    laptops, other servers), gated by Tailscale identity. No public
    exposure unless the operator separately enables Funnel — which we
    intentionally don't wire up yet to keep the default safe.
    """
    id = "tailscale"
    name = "Tailscale"
    install_url = "https://tailscale.com/download"

    def _binary(self) -> Optional[str]:
        return tailscale_binary()

    def _status_json(self) -> Optional[dict[str, Any]]:
        bin_ = self._binary()
        if not bin_:
            return None
        rc, out, _ = _run([bin_, "status", "--json"])
        if rc != 0 or not out.strip():
            return None
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            return None

    def _serve_status(self) -> Optional[dict[str, Any]]:
        bin_ = self._binary()
        if not bin_:
            return None
        rc, out, _ = _run([bin_, "serve", "status", "--json"])
        if rc != 0 or not out.strip():
            return None
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            return None

    def _self_url(self, status_json: dict[str, Any]) -> Optional[str]:
        """Construct the https://<hostname>.<tailnet>.ts.net URL for this node."""
        self_ = status_json.get("Self") or {}
        dns = self_.get("DNSName") or ""
        dns = dns.rstrip(".")
        if not dns:
            return None
        return f"https://{dns}"

    def _active_serve_url(self) -> Optional[str]:
        """Return the URL currently being served, or None if Serve is off.

        Modern Tailscale (1.50+) puts active mappings under Web[host:443].Handlers["/"].Proxy.
        """
        serve = self._serve_status()
        if not serve:
            return None
        web = serve.get("Web") or {}
        if not web:
            return None
        # Take the first https endpoint — we only ever set one.
        for host_port in web:
            host = host_port.split(":")[0]
            return f"https://{host}"
        return None

    def state(self) -> _ProviderState:
        if not self._binary():
            return _ProviderState(
                id=self.id,
                name=self.name,
                installed=False,
                ready=False,
                sharing=False,
                url=None,
                detail="Not installed",
                hint="Install the Tailscale agent on this host, then refresh.",
                install_url=self.install_url,
            )

        status_json = self._status_json()
        if status_json is None:
            return _ProviderState(
                id=self.id, name=self.name, installed=True, ready=False,
                sharing=False, url=None,
                detail="Tailscale daemon not responding",
                hint="Start the Tailscale service (e.g. `sudo tailscale up`).",
                install_url=self.install_url,
            )

        backend = (status_json.get("BackendState") or "").lower()
        if backend != "running":
            return _ProviderState(
                id=self.id, name=self.name, installed=True, ready=False,
                sharing=False, url=None,
                detail=f"Not signed in (state: {backend or 'unknown'})",
                hint="Run `sudo tailscale up` and sign into your tailnet.",
                install_url=self.install_url,
            )

        active = self._active_serve_url()
        self_url = self._self_url(status_json)
        return _ProviderState(
            id=self.id,
            name=self.name,
            installed=True,
            ready=True,
            sharing=active is not None,
            url=active or self_url,
            detail=(
                f"Sharing on {active}" if active
                else "Ready — click Enable to share"
            ),
            hint=None,
            install_url=self.install_url,
        )

    def enable(self, port: int) -> _ProviderState:
        bin_ = self._binary()
        if not bin_:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Tailscale is not installed on this host.",
            )
        # `tailscale serve --bg <port>` is the universal invocation across
        # 1.50+ — it terminates HTTPS on 443 and reverse-proxies to
        # http://127.0.0.1:<port>. --bg keeps it active across restarts
        # of the calling shell (it's persisted in tailscaled's state).
        rc, out, err = _run([bin_, "serve", "--bg", str(port)], timeout=15.0)
        if rc != 0:
            # Surface the real CLI error — usually "needs root" or
            # "not logged in" — so the user can act on it directly.
            msg = (err or out or "tailscale serve failed").strip()
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=msg[:500],
            )
        return self.state()

    def disable(self) -> _ProviderState:
        bin_ = self._binary()
        if not bin_:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Tailscale is not installed on this host.",
            )
        rc, out, err = _run([bin_, "serve", "reset"], timeout=10.0)
        if rc != 0:
            msg = (err or out or "tailscale serve reset failed").strip()
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=msg[:500],
            )
        return self.state()


# ── Registry ─────────────────────────────────────────────────────────────────
# Single source of truth. To add Cloudflare Tunnel later: implement a
# CloudflareTunnelProvider with the same shape and append it here.

_PROVIDERS: list[_Provider] = [TailscaleProvider()]


def _provider_by_id(provider_id: str) -> _Provider:
    for p in _PROVIDERS:
        if p.id == provider_id:
            return p
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Unknown remote-access provider: {provider_id}",
    )


# ── Schemas ──────────────────────────────────────────────────────────────────


class EnableRequest(BaseModel):
    port: int = Field(
        default=8000,
        ge=1,
        le=65535,
        description="Local port to expose. Defaults to the WatchTower API port.",
    )


class ProviderResponse(BaseModel):
    id: str
    name: str
    installed: bool
    ready: bool
    sharing: bool
    url: Optional[str] = None
    detail: Optional[str] = None
    hint: Optional[str] = None
    install_url: Optional[str] = None


def _serialize(s: _ProviderState) -> ProviderResponse:
    return ProviderResponse(
        id=s.id, name=s.name,
        installed=s.installed, ready=s.ready, sharing=s.sharing,
        url=s.url, detail=s.detail, hint=s.hint, install_url=s.install_url,
    )


def _watchtower_port() -> int:
    """Best-effort default port for the enable button."""
    try:
        return int(os.getenv("WATCHTOWER_PORT", "8000"))
    except ValueError:
        return 8000


# ── Routes ───────────────────────────────────────────────────────────────────


@router.get("/providers", response_model=list[ProviderResponse])
async def list_providers(
    _current_user: dict = Depends(util.get_current_user),
) -> list[ProviderResponse]:
    """List all known remote-access providers with current detection state."""
    return [_serialize(p.state()) for p in _PROVIDERS]


@router.get("/providers/{provider_id}", response_model=ProviderResponse)
async def get_provider(
    provider_id: str,
    _current_user: dict = Depends(util.get_current_user),
) -> ProviderResponse:
    return _serialize(_provider_by_id(provider_id).state())


@router.post("/providers/{provider_id}/enable", response_model=ProviderResponse)
async def enable_provider(
    provider_id: str,
    body: EnableRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> ProviderResponse:
    """Start sharing the WatchTower port via this provider."""
    provider = _provider_by_id(provider_id)
    state = provider.enable(body.port)

    # Audit. Best-effort org resolution so the row lands in the right
    # tenant; static-token callers won't have an org and that's fine.
    org_id = None
    try:
        from watchtower.api.enterprise import _ensure_user_org_member
        _u, org, _m = _ensure_user_org_member(db, current_user)
        org_id = org.id
    except Exception:  # noqa: BLE001 - org resolution is non-load-bearing here
        pass
    audit_log.record_for_user(
        db, current_user,
        action=f"remote_access.{provider_id}.enable",
        entity_type="remote_access_provider",
        org_id=org_id,
        request=request,
        extra={"port": body.port, "url": state.url},
    )
    db.commit()
    return _serialize(state)


@router.post("/providers/{provider_id}/disable", response_model=ProviderResponse)
async def disable_provider(
    provider_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: dict = Depends(util.get_current_user),
) -> ProviderResponse:
    """Stop sharing via this provider."""
    provider = _provider_by_id(provider_id)
    state = provider.disable()

    org_id = None
    try:
        from watchtower.api.enterprise import _ensure_user_org_member
        _u, org, _m = _ensure_user_org_member(db, current_user)
        org_id = org.id
    except Exception:  # noqa: BLE001
        pass
    audit_log.record_for_user(
        db, current_user,
        action=f"remote_access.{provider_id}.disable",
        entity_type="remote_access_provider",
        org_id=org_id,
        request=request,
        extra={},
    )
    db.commit()
    return _serialize(state)


@router.get("/default-port")
async def default_port(
    _current_user: dict = Depends(util.get_current_user),
) -> dict[str, int]:
    """Suggested port for the Enable button — what the API itself is bound to."""
    return {"port": _watchtower_port()}
