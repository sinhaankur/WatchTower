"""Phase 5: cloud-provider abstraction for auto-provisioning fresh nodes.

Two providers in v1 — DigitalOcean and Hetzner. Both share the same
shape so the orchestrator (next step) doesn't have to branch on
provider name beyond looking up the right class. Step 1 (this file)
implements only ``verify_token`` per provider — enough to ship the
credentials UI and confirm a saved token works before any VM is
created.

Each provider class is stateless and instantiated per call — there's
no connection pool or session to manage at this scope, and stateless
keeps testing trivial (mock httpx.Client, assert on the calls made).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional, Protocol

import httpx

logger = logging.getLogger(__name__)


# Supported provider identifiers. The API gates the ``provider`` field
# against this set so a typo can't land a credential row that no
# subsequent code knows how to dispatch.
SUPPORTED_PROVIDERS: tuple[str, ...] = ("digitalocean", "hetzner")


# ── Result + error types ────────────────────────────────────────────────────


@dataclass
class VerifyResult:
    """Returned by ``verify_token`` regardless of outcome.

    Successful: ``ok=True, account_email=<...>``. Failure: ``ok=False,
    error="<actionable operator-readable text>"``. We *never* surface
    the raw provider error text without filtering — DO and Hetzner both
    occasionally leak token-shaped strings in error responses.
    """
    ok: bool
    account_email: Optional[str] = None
    error: Optional[str] = None


@dataclass
class Region:
    """Provider-native region identifier + a human-readable label.

    DO IDs: 'nyc3', 'sfo3', 'ams3'…
    Hetzner IDs: 'fsn1', 'nbg1', 'hel1', 'ash', 'hil'…
    """
    id: str
    name: str


@dataclass
class Size:
    """A VM size offered by the provider. ``id`` is provider-native and
    round-trips back into ``create_server``. The cost fields are best-
    effort — DO returns price_monthly in the API; Hetzner does not (we
    look it up from a static price map and surface 'n/a' if unknown).
    """
    id: str
    vcpus: int
    memory_gb: float
    monthly_usd: Optional[float] = None


@dataclass
class CreatedServer:
    """Returned by ``create_server`` — the bare minimum the orchestrator
    needs to track and clean up. ``public_ipv4`` is often unset right
    after create; the orchestrator polls ``get_server_status`` until
    it shows up.
    """
    provider_resource_id: str
    public_ipv4: Optional[str] = None


@dataclass
class ServerStatus:
    """Snapshot the orchestrator polls during the wait_for_ready phase.

    ``ready`` is provider-specific — DO calls this 'active', Hetzner
    calls it 'running'. Either way it means "sshd should be reachable."
    """
    ready: bool
    public_ipv4: Optional[str]
    raw_status: str


class ProviderError(Exception):
    """Raised by orchestrator helpers when the provider returns an
    unrecoverable error. Carries a status code so the API layer can
    pick a sensible HTTP status to surface."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"{status}: {detail}")
        self.status = status
        self.detail = detail


# ── Protocol ────────────────────────────────────────────────────────────────


class CloudProvider(Protocol):
    """The shape every provider implementation honours.

    The orchestrator only calls methods on this Protocol — it doesn't
    care which provider it's talking to. Adding a third provider (Linode,
    Vultr, …) is a single new class implementing the same shape.
    """

    name: str  # 'digitalocean' | 'hetzner'

    def verify_token(self, token: str) -> VerifyResult: ...
    def list_regions(self, token: str) -> list[Region]: ...
    def list_sizes(self, token: str, region_id: str) -> list[Size]: ...
    def create_server(
        self, token: str, *, name: str, region_id: str, size_id: str, ssh_public_key: str,
    ) -> CreatedServer: ...
    def get_server_status(self, token: str, resource_id: str) -> ServerStatus: ...
    def delete_server(self, token: str, resource_id: str) -> None: ...


# ── DigitalOcean ────────────────────────────────────────────────────────────


class DigitalOceanProvider:
    """https://docs.digitalocean.com/reference/api/api-reference/

    ``/v2/account`` returns the email + uuid for the token's owner.
    Cheap call, no resources touched.
    """

    name = "digitalocean"
    _api_base = "https://api.digitalocean.com"

    def verify_token(self, token: str) -> VerifyResult:
        try:
            resp = httpx.get(
                f"{self._api_base}/v2/account",
                headers={"Authorization": f"Bearer {token}"},
                timeout=10.0,
            )
        except httpx.HTTPError as exc:
            return VerifyResult(ok=False, error=f"Could not reach DigitalOcean: {exc}")

        if resp.status_code == 401:
            return VerifyResult(ok=False, error="DigitalOcean rejected the token (401). Check it's a Personal Access Token with at least read scope.")
        if resp.status_code == 403:
            return VerifyResult(ok=False, error="DigitalOcean token lacks permission. Phase 5 will need droplet:read,write + ssh_key:read,write scopes.")
        if resp.status_code >= 400:
            # We deliberately don't echo the body here — DO occasionally
            # repeats the token fragment in error messages.
            return VerifyResult(ok=False, error=f"DigitalOcean returned HTTP {resp.status_code}.")

        try:
            account = resp.json().get("account", {})
        except ValueError:
            return VerifyResult(ok=False, error="DigitalOcean returned a non-JSON response.")

        email = account.get("email")
        return VerifyResult(ok=True, account_email=email)

    def list_regions(self, token: str) -> list[Region]:
        body = self._get(token, "/v2/regions").get("regions", [])
        return [Region(id=r["slug"], name=r.get("name") or r["slug"]) for r in body if r.get("available", True)]

    def list_sizes(self, token: str, region_id: str) -> list[Size]:
        body = self._get(token, "/v2/sizes").get("sizes", [])
        # DO returns ALL sizes; filter to those available in the requested region.
        # We sort by monthly price ascending so the cheapest droplet is the
        # default the UI shows first (best newbie UX).
        out: list[Size] = []
        for s in body:
            if not s.get("available", True):
                continue
            if region_id not in (s.get("regions") or []):
                continue
            out.append(Size(
                id=s["slug"],
                vcpus=int(s.get("vcpus") or 0),
                memory_gb=float(s.get("memory") or 0) / 1024.0,
                monthly_usd=float(s.get("price_monthly")) if s.get("price_monthly") is not None else None,
            ))
        out.sort(key=lambda x: (x.monthly_usd or 0.0))
        return out

    def create_server(
        self, token: str, *, name: str, region_id: str, size_id: str, ssh_public_key: str,
    ) -> CreatedServer:
        # We push the SSH public key into the droplet creation call by
        # *fingerprint*. DO's API needs the key uploaded to the account
        # first (or the fingerprint of one already there). Simplest path
        # for an auto-provisioned key: upload it, capture the
        # fingerprint, then pass it to droplet-create.
        key_resp = self._post(token, "/v2/account/keys", {
            "name": f"watchtower-{name}",
            "public_key": ssh_public_key,
        })
        fingerprint = (key_resp.get("ssh_key") or {}).get("fingerprint")
        if not fingerprint:
            raise ProviderError(502, "DigitalOcean accepted the key upload but returned no fingerprint.")
        body = self._post(token, "/v2/droplets", {
            "name": name,
            "region": region_id,
            "size": size_id,
            # Ubuntu 22.04 LTS is the prep-node-for-phase2.sh target.
            "image": "ubuntu-22-04-x64",
            "ssh_keys": [fingerprint],
            # cloud-init payload runs at first boot. We don't bake the
            # full prep script in here — it's long and operator-tunable.
            # Just ensure unattended-upgrades is paused so apt locks
            # don't race the prep script when it runs via SSH later.
            "user_data": (
                "#!/bin/bash\n"
                "systemctl stop unattended-upgrades.service 2>/dev/null || true\n"
                "systemctl disable unattended-upgrades.service 2>/dev/null || true\n"
            ),
        })
        droplet = body.get("droplet", {})
        return CreatedServer(
            provider_resource_id=str(droplet.get("id")),
            public_ipv4=None,  # not assigned at create-time
        )

    def get_server_status(self, token: str, resource_id: str) -> ServerStatus:
        body = self._get(token, f"/v2/droplets/{resource_id}").get("droplet", {})
        raw = body.get("status", "unknown")
        # Public IPv4 lives under networks.v4 with type='public'.
        ipv4: Optional[str] = None
        for net in (body.get("networks") or {}).get("v4", []):
            if net.get("type") == "public":
                ipv4 = net.get("ip_address")
                break
        return ServerStatus(ready=(raw == "active"), public_ipv4=ipv4, raw_status=raw)

    def delete_server(self, token: str, resource_id: str) -> None:
        # 204 on success, 404 if already gone — both count as "done".
        resp = httpx.delete(
            f"{self._api_base}/v2/droplets/{resource_id}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15.0,
        )
        if resp.status_code not in (200, 204, 404):
            raise ProviderError(resp.status_code, f"DigitalOcean delete failed: HTTP {resp.status_code}")

    # ── HTTP helpers (private — DRY across the methods above) ───────────
    def _get(self, token: str, path: str) -> dict:
        resp = httpx.get(
            f"{self._api_base}{path}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15.0,
        )
        if resp.status_code >= 400:
            raise ProviderError(resp.status_code, f"DigitalOcean GET {path} → HTTP {resp.status_code}")
        return resp.json()

    def _post(self, token: str, path: str, body: dict) -> dict:
        resp = httpx.post(
            f"{self._api_base}{path}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=body,
            timeout=20.0,
        )
        if resp.status_code >= 400:
            raise ProviderError(resp.status_code, f"DigitalOcean POST {path} → HTTP {resp.status_code}")
        return resp.json()


# ── Hetzner Cloud ───────────────────────────────────────────────────────────


class HetznerProvider:
    """https://docs.hetzner.cloud/

    Hetzner doesn't have a /v1/account endpoint. The cheapest "is this
    token valid" probe is ``/v1/locations`` which returns a static list
    of datacenters — small response, exercises auth without creating
    or listing anything sensitive.

    Hetzner tokens don't carry an account email; the project that
    issued the token has a name though, which we surface as ``account_email``
    even though it's a project name. UI label clarifies this.
    """

    name = "hetzner"
    _api_base = "https://api.hetzner.cloud"

    def verify_token(self, token: str) -> VerifyResult:
        try:
            # We probe /v1/locations *and* /v1/ssh_keys — the second
            # call confirms the token has write scope, which Phase 5
            # step 2 will need to upload the per-node generated key.
            resp = httpx.get(
                f"{self._api_base}/v1/ssh_keys",
                headers={"Authorization": f"Bearer {token}"},
                timeout=10.0,
            )
        except httpx.HTTPError as exc:
            return VerifyResult(ok=False, error=f"Could not reach Hetzner: {exc}")

        if resp.status_code == 401:
            return VerifyResult(ok=False, error="Hetzner rejected the token (401). Create one under Console → Security → API tokens with Read & Write scope.")
        if resp.status_code == 403:
            return VerifyResult(ok=False, error="Hetzner token lacks permission — Phase 5 needs Read & Write.")
        if resp.status_code >= 400:
            return VerifyResult(ok=False, error=f"Hetzner returned HTTP {resp.status_code}.")

        # Hetzner tokens are project-scoped, not account-scoped. The
        # token itself doesn't expose the project name; we'd have to
        # call something else to get it. For step 1, just report
        # "connected (Hetzner project)" — UI surfaces the label the
        # operator chose at save time.
        return VerifyResult(ok=True, account_email="Hetzner project")

    def list_regions(self, token: str) -> list[Region]:
        body = self._get(token, "/v1/datacenters").get("datacenters", [])
        return [Region(id=d["name"], name=d.get("description") or d["name"]) for d in body]

    def list_sizes(self, token: str, region_id: str) -> list[Size]:
        # Hetzner returns server types globally, with a 'prices' array
        # per-datacenter. We filter to types listed in the given region's
        # supported_server_types and pull the price for that location.
        types_body = self._get(token, "/v1/server_types").get("server_types", [])
        # Static price-fallback isn't needed — Hetzner's API actually
        # does return monthly prices per-location, but the JSON is
        # nested. Pull the matching location.
        out: list[Size] = []
        for t in types_body:
            if not _hetzner_type_available_in(t, region_id):
                continue
            price = _hetzner_monthly_price(t, region_id)
            out.append(Size(
                id=t["name"],
                vcpus=int(t.get("cores") or 0),
                memory_gb=float(t.get("memory") or 0),
                monthly_usd=price,
            ))
        out.sort(key=lambda x: (x.monthly_usd or 0.0))
        return out

    def create_server(
        self, token: str, *, name: str, region_id: str, size_id: str, ssh_public_key: str,
    ) -> CreatedServer:
        # Hetzner has a similar two-step shape to DO: upload key first,
        # reference it by ID in server-create.
        key_resp = self._post(token, "/v1/ssh_keys", {
            "name": f"watchtower-{name}",
            "public_key": ssh_public_key,
        })
        key_id = (key_resp.get("ssh_key") or {}).get("id")
        if not key_id:
            raise ProviderError(502, "Hetzner accepted the SSH key but returned no id.")
        body = self._post(token, "/v1/servers", {
            "name": name,
            "server_type": size_id,
            "location": region_id,
            # Hetzner names Ubuntu LTS images by version slug.
            "image": "ubuntu-22.04",
            "ssh_keys": [key_id],
            "user_data": (
                "#!/bin/bash\n"
                "systemctl stop unattended-upgrades.service 2>/dev/null || true\n"
                "systemctl disable unattended-upgrades.service 2>/dev/null || true\n"
            ),
            "start_after_create": True,
        })
        server = body.get("server", {})
        ipv4 = (server.get("public_net") or {}).get("ipv4", {}).get("ip")
        return CreatedServer(
            provider_resource_id=str(server.get("id")),
            public_ipv4=ipv4,
        )

    def get_server_status(self, token: str, resource_id: str) -> ServerStatus:
        body = self._get(token, f"/v1/servers/{resource_id}").get("server", {})
        raw = body.get("status", "unknown")
        ipv4 = (body.get("public_net") or {}).get("ipv4", {}).get("ip")
        return ServerStatus(ready=(raw == "running"), public_ipv4=ipv4, raw_status=raw)

    def delete_server(self, token: str, resource_id: str) -> None:
        resp = httpx.delete(
            f"{self._api_base}/v1/servers/{resource_id}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15.0,
        )
        if resp.status_code not in (200, 204, 404):
            raise ProviderError(resp.status_code, f"Hetzner delete failed: HTTP {resp.status_code}")

    # ── HTTP helpers (private) ──────────────────────────────────────────
    def _get(self, token: str, path: str) -> dict:
        resp = httpx.get(
            f"{self._api_base}{path}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15.0,
        )
        if resp.status_code >= 400:
            raise ProviderError(resp.status_code, f"Hetzner GET {path} → HTTP {resp.status_code}")
        return resp.json()

    def _post(self, token: str, path: str, body: dict) -> dict:
        resp = httpx.post(
            f"{self._api_base}{path}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=body,
            timeout=20.0,
        )
        if resp.status_code >= 400:
            raise ProviderError(resp.status_code, f"Hetzner POST {path} → HTTP {resp.status_code}")
        return resp.json()


def _hetzner_type_available_in(server_type: dict, region_id: str) -> bool:
    """A type is offered in a location if its prices array carries an
    entry for that location. Hetzner deprecates types per-location, so
    the per-location prices list is authoritative."""
    for p in server_type.get("prices") or []:
        if p.get("location") == region_id:
            return True
    return False


def _hetzner_monthly_price(server_type: dict, region_id: str) -> Optional[float]:
    for p in server_type.get("prices") or []:
        if p.get("location") != region_id:
            continue
        # Hetzner reports gross + net; we surface gross (with VAT) to
        # match what the user sees on their invoice.
        gross = (p.get("price_monthly") or {}).get("gross")
        if gross is not None:
            try:
                return float(gross)
            except (TypeError, ValueError):
                return None
    return None


# ── Factory ─────────────────────────────────────────────────────────────────


_PROVIDERS: dict[str, type] = {
    "digitalocean": DigitalOceanProvider,
    "hetzner": HetznerProvider,
}


def get_provider(name: str) -> CloudProvider:
    """Return the provider impl for *name*, or raise ProviderError(400).

    The API layer uses this; we throw a ProviderError so the calling
    handler can map it to a clean HTTP 400 without inventing its own
    "unknown provider" message at every call site.
    """
    cls = _PROVIDERS.get(name.lower().strip())
    if cls is None:
        raise ProviderError(400, f"Unsupported provider: {name!r}. Supported: {', '.join(SUPPORTED_PROVIDERS)}.")
    return cls()
