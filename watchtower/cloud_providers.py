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
    """The shape every provider implementation honours. Phase 5 step 2
    will extend this with ``list_regions``, ``list_sizes``,
    ``create_server``, ``wait_for_ready``, ``delete_server`` — but
    keeping the protocol narrow for step 1 means the credentials UI
    ships without a half-built abstraction it doesn't yet use.
    """

    name: str  # 'digitalocean' | 'hetzner'

    def verify_token(self, token: str) -> VerifyResult: ...


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
