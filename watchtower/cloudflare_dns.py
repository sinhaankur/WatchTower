"""Cloudflare DNS helpers for Phase 2 of the CF integration.

This module owns the actual Cloudflare API calls that create / update
/ delete DNS A records. The /api/projects/.../cloudflare/sync endpoint
is the only consumer; the rules of the road:

* Idempotent. Calling ``sync_a_record`` twice with the same target IP
  is a no-op (Cloudflare returns the same record_id).
* Strict zone matching. The zone is the *longest* DNS suffix the
  token has access to that matches the requested hostname. So
  ``foo.bar.example.com`` will pick the ``example.com`` zone if
  that's the only match, or ``bar.example.com`` if the token also
  owns that finer zone. We never silently fall back to a parent
  zone the token doesn't actually have access to.
* Errors are typed. ``CloudflareDnsError`` carries an HTTP-style
  ``status`` (400, 403, 404, 502) so the API handler can map cleanly
  to a response code without re-parsing exception messages.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

import requests

logger = logging.getLogger(__name__)

CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"


class CloudflareDnsError(Exception):
    """Raised by all sync/delete helpers. ``status`` mirrors HTTP
    semantics so the FastAPI handler can pass it straight through."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass(frozen=True)
class _Zone:
    id: str
    name: str


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _cf_get(token: str, path: str, params: Optional[dict] = None) -> dict:
    try:
        resp = requests.get(f"{CLOUDFLARE_API_BASE}{path}", headers=_headers(token), params=params, timeout=15)
    except requests.RequestException as exc:
        raise CloudflareDnsError(502, f"Cloudflare unreachable: {exc}") from exc
    return _interpret(resp)


def _cf_post(token: str, path: str, body: dict) -> dict:
    try:
        resp = requests.post(f"{CLOUDFLARE_API_BASE}{path}", headers=_headers(token), json=body, timeout=15)
    except requests.RequestException as exc:
        raise CloudflareDnsError(502, f"Cloudflare unreachable: {exc}") from exc
    return _interpret(resp)


def _cf_put(token: str, path: str, body: dict) -> dict:
    try:
        resp = requests.put(f"{CLOUDFLARE_API_BASE}{path}", headers=_headers(token), json=body, timeout=15)
    except requests.RequestException as exc:
        raise CloudflareDnsError(502, f"Cloudflare unreachable: {exc}") from exc
    return _interpret(resp)


def _cf_delete(token: str, path: str) -> dict:
    try:
        resp = requests.delete(f"{CLOUDFLARE_API_BASE}{path}", headers=_headers(token), timeout=15)
    except requests.RequestException as exc:
        raise CloudflareDnsError(502, f"Cloudflare unreachable: {exc}") from exc
    return _interpret(resp)


def _interpret(resp) -> dict:
    """Translate a Cloudflare HTTP response into a dict, or raise."""
    if resp.status_code == 401 or resp.status_code == 403:
        raise CloudflareDnsError(403, "Cloudflare rejected the token (insufficient scope or revoked).")
    body = {}
    try:
        body = resp.json() or {}
    except ValueError:
        pass
    if resp.status_code >= 400 or not body.get("success", True):
        errs = "; ".join(e.get("message", "") for e in body.get("errors") or []) or resp.text[:200]
        raise CloudflareDnsError(resp.status_code if resp.status_code >= 400 else 502, errs or "Cloudflare error")
    return body


def find_zone_for_domain(token: str, domain: str) -> _Zone:
    """Find the longest-suffix zone the token has access to.

    Cloudflare's ``GET /zones?name=...`` is exact-match only, so we
    walk ``foo.bar.example.com`` → ``bar.example.com`` → ``example.com``
    and stop at the first one the token can see. This lets a token
    scoped to ``example.com`` cover all subdomains, and a finer-scoped
    token still resolve correctly.
    """
    parts = domain.strip().lower().rstrip(".").split(".")
    if len(parts) < 2:
        raise CloudflareDnsError(400, f"'{domain}' is not a valid hostname.")

    # Try progressively shorter suffixes (longest first).
    for i in range(len(parts) - 1):
        candidate = ".".join(parts[i:])
        body = _cf_get(token, "/zones", params={"name": candidate})
        results = body.get("result") or []
        if results:
            zone = results[0]
            return _Zone(id=zone["id"], name=zone["name"])

    raise CloudflareDnsError(
        404,
        f"No Cloudflare zone found for '{domain}'. Verify the token has Zone:Read on the parent domain and that the zone exists in this account.",
    )


@dataclass
class SyncResult:
    record_id: str
    zone_id: str
    zone_name: str
    target_ip: str


def sync_a_record(
    token: str,
    domain: str,
    target_ip: str,
    *,
    existing_zone_id: Optional[str] = None,
    existing_record_id: Optional[str] = None,
    proxied: bool = False,
) -> SyncResult:
    """Create or update an A record so ``domain`` points at ``target_ip``.

    Caller passes ``existing_zone_id`` + ``existing_record_id`` when the
    domain has been synced before — we skip the zone lookup and update
    the record in place. If either is stale (Cloudflare returns 404),
    we fall back to a fresh lookup + create.

    ``proxied=False`` matches what Phase 2 needs (DNS-only, "grey cloud")
    so the operator's existing Let's Encrypt cert workflow keeps working.
    Phase 3 will flip ``proxied=True`` when fronting the LB.
    """
    zone_id = existing_zone_id
    zone_name = ""
    if not zone_id:
        zone = find_zone_for_domain(token, domain)
        zone_id = zone.id
        zone_name = zone.name

    record_payload = {
        "type": "A",
        "name": domain,
        "content": target_ip,
        "ttl": 1,           # 1 == "auto" in Cloudflare
        "proxied": proxied,
    }

    if existing_record_id:
        try:
            body = _cf_put(token, f"/zones/{zone_id}/dns_records/{existing_record_id}", record_payload)
            rec = body["result"]
            return SyncResult(record_id=rec["id"], zone_id=zone_id, zone_name=zone_name or rec.get("zone_name", ""), target_ip=target_ip)
        except CloudflareDnsError as exc:
            if exc.status != 404:
                raise
            # Record was deleted out-of-band; fall through to create.
            logger.info("Cloudflare record %s missing — creating fresh.", existing_record_id)

    body = _cf_post(token, f"/zones/{zone_id}/dns_records", record_payload)
    rec = body["result"]
    return SyncResult(
        record_id=rec["id"],
        zone_id=zone_id,
        zone_name=zone_name or rec.get("zone_name", ""),
        target_ip=target_ip,
    )


def delete_a_record(token: str, zone_id: str, record_id: str) -> None:
    """Delete the record. Treats 404 as success — the desired end state
    is "record gone", and discovering it's already gone counts."""
    try:
        _cf_delete(token, f"/zones/{zone_id}/dns_records/{record_id}")
    except CloudflareDnsError as exc:
        if exc.status == 404:
            return
        raise


# ── Cloudflare Tunnel (remotely-managed) ──────────────────────────────────────
# A remotely-managed tunnel is created via the API and configured entirely
# server-side (config_src=cloudflare). The node just runs `cloudflared` with
# the returned token — no local config file, no `cloudflared login`. This is
# what makes one-click Go-Live-over-tunnel possible: the user never touches
# the deploy host's cloudflared config; WatchTower owns it through the API.
#
# The hostname is pointed at the tunnel with a CNAME to
# ``<tunnel_id>.cfargotunnel.com`` (always proxied — that's how tunnels work).


@dataclass
class TunnelResult:
    tunnel_id: str
    token: str          # the connector token — sensitive, store encrypted
    name: str


def create_tunnel(token: str, account_id: str, name: str) -> TunnelResult:
    """Create (or reuse) a remotely-managed tunnel and return its id + token.

    Idempotent on name: if a tunnel with this name already exists and isn't
    deleted, we reuse it and fetch its token rather than erroring on the
    duplicate — so re-running Go-Live doesn't pile up tunnels.
    """
    if not account_id:
        raise CloudflareDnsError(400, "Cloudflare account_id is required to create a tunnel.")

    base = f"/accounts/{account_id}/cfd_tunnel"
    existing_id: Optional[str] = None
    # Look for a live tunnel with this name first.
    listing = _cf_get(token, base, params={"name": name, "is_deleted": "false"})
    for t in listing.get("result") or []:
        if t.get("name") == name and not t.get("deleted_at"):
            existing_id = t.get("id")
            break

    if existing_id:
        tunnel_id = existing_id
    else:
        created = _cf_post(token, base, {"name": name, "config_src": "cloudflare"})
        tunnel_id = (created.get("result") or {}).get("id")
        if not tunnel_id:
            raise CloudflareDnsError(502, "Cloudflare did not return a tunnel id.")

    # Fetch the connector token (works for both new and reused tunnels).
    tok_body = _cf_get(token, f"{base}/{tunnel_id}/token")
    connector_token = tok_body.get("result")
    if not isinstance(connector_token, str) or not connector_token:
        raise CloudflareDnsError(502, "Cloudflare did not return a tunnel connector token.")

    return TunnelResult(tunnel_id=tunnel_id, token=connector_token, name=name)


def configure_tunnel_ingress(
    token: str, account_id: str, tunnel_id: str, hostname: str, service_url: str
) -> None:
    """Point the tunnel's ingress at the local service.

    Sets a single ingress rule (hostname → service_url) plus the required
    catch-all 404. Overwrites any prior config for this tunnel — Go-Live
    owns one hostname per tunnel.
    """
    path = f"/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations"
    body = {
        "config": {
            "ingress": [
                {"hostname": hostname, "service": service_url},
                {"service": "http_status:404"},
            ]
        }
    }
    _cf_put(token, path, body)


def sync_cname(
    token: str,
    domain: str,
    target: str,
    *,
    existing_zone_id: Optional[str] = None,
    existing_record_id: Optional[str] = None,
) -> SyncResult:
    """Create/update a proxied CNAME so ``domain`` → ``target`` (the
    ``<tunnel_id>.cfargotunnel.com`` host). Mirrors sync_a_record's
    idempotent create-or-update shape; tunnel CNAMEs are always proxied."""
    if existing_zone_id:
        zone_id, zone_name = existing_zone_id, ""
    else:
        zone = find_zone_for_domain(token, domain)
        zone_id, zone_name = zone.id, zone.name

    record_body = {"type": "CNAME", "name": domain, "content": target, "proxied": True}

    if existing_record_id:
        body = _cf_put(token, f"/zones/{zone_id}/dns_records/{existing_record_id}", record_body)
    else:
        # Find an existing CNAME for this name to avoid duplicate-record errors.
        found = _cf_get(token, f"/zones/{zone_id}/dns_records", params={"type": "CNAME", "name": domain})
        results = found.get("result") or []
        if results:
            rid = results[0]["id"]
            body = _cf_put(token, f"/zones/{zone_id}/dns_records/{rid}", record_body)
        else:
            body = _cf_post(token, f"/zones/{zone_id}/dns_records", record_body)

    rec = body.get("result") or {}
    return SyncResult(
        record_id=rec.get("id", existing_record_id or ""),
        zone_id=zone_id,
        zone_name=zone_name or rec.get("zone_name", ""),
        target_ip=target,
    )


def delete_tunnel(token: str, account_id: str, tunnel_id: str) -> None:
    """Delete a tunnel. 404 = already gone = success."""
    try:
        _cf_delete(token, f"/accounts/{account_id}/cfd_tunnel/{tunnel_id}")
    except CloudflareDnsError as exc:
        if exc.status == 404:
            return
        raise
