"""Phase 5 step 1: CRUD + verify for cloud-provider credentials.

The provider's HTTP call is mocked at the class level so no real DO /
Hetzner traffic happens in CI. Tests assert on the storage contract
(token encrypted at rest, plaintext never leaked) and the auth/audit
shape that the API surface MUST honour."""
from __future__ import annotations

from unittest.mock import patch
from uuid import UUID

from fastapi.testclient import TestClient

from watchtower import cloud_providers
from watchtower.cloud_providers import VerifyResult
from watchtower.database import AuditEvent, CloudProviderCredential


# ── Mocks ────────────────────────────────────────────────────────────────────


class _FakeProvider:
    def __init__(self, name: str, result: VerifyResult):
        self.name = name
        self._result = result
    def verify_token(self, _token: str) -> VerifyResult:
        return self._result


def _patch_verify(ok: bool, *, email: str | None = None, error: str | None = None):
    """Replace ``get_provider`` so the API never touches a real
    provider HTTP endpoint. Patches at both the source module and the
    API consumer module — Python caches name bindings at import time,
    so patching only ``cloud_providers.get_provider`` misses the
    already-imported reference in ``api/cloud_providers.py``.
    """
    result = VerifyResult(ok=ok, account_email=email, error=error)
    def fake(name: str):
        return _FakeProvider(name.lower(), result)
    from watchtower.api import cloud_providers as api_module
    return patch.multiple(
        api_module.providers,  # the name bound inside the API module
        get_provider=fake,
    )


# ── Create ───────────────────────────────────────────────────────────────────


def test_create_credential_happy_path(client: TestClient, db_session):
    with _patch_verify(True, email="ops@example.com"):
        r = client.post("/api/integrations/cloud-providers", json={
            "provider": "digitalocean",
            "api_token": "dop_v1_FAKETOKEN_at_least_10",
            "label": "Personal DO",
        })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["provider"] == "digitalocean"
    assert body["account_email"] == "ops@example.com"
    assert body["label"] == "Personal DO"
    # The response MUST NOT echo the token in any field — defensive
    # check against a future refactor that adds the field.
    assert "api_token" not in body
    assert "FAKETOKEN" not in str(body)


def test_create_credential_rejects_unsupported_provider(client: TestClient):
    r = client.post("/api/integrations/cloud-providers", json={
        "provider": "linode",  # not in SUPPORTED_PROVIDERS
        "api_token": "fake-token-1234567890",
    })
    assert r.status_code == 400
    assert "linode" in r.json()["detail"] or "Unsupported" in r.json()["detail"]


def test_create_credential_rejects_when_provider_says_invalid(client: TestClient, db_session):
    """Surface the provider's reason to the operator so they can fix
    the token, rather than a generic 'failed' that requires log-diving."""
    with _patch_verify(False, error="DigitalOcean rejected the token (401)."):
        r = client.post("/api/integrations/cloud-providers", json={
            "provider": "digitalocean",
            "api_token": "dop_v1_BADTOKEN_at_least_10",
        })
    assert r.status_code == 400
    assert "401" in r.json()["detail"]
    # Nothing persisted.
    rows = db_session.query(CloudProviderCredential).all()
    assert rows == []


def test_token_stored_encrypted(client: TestClient, db_session):
    """The api_token_encrypted column must not contain the plaintext
    token. This is a regression guard — if encrypt_secret stops being
    called (or starts returning the input verbatim under some config),
    we want a loud red signal."""
    plaintext = "dop_v1_PLAINTEXTTOKEN_at_least_20"
    with _patch_verify(True, email="ops@example.com"):
        r = client.post("/api/integrations/cloud-providers", json={
            "provider": "digitalocean",
            "api_token": plaintext,
        })
    assert r.status_code == 201
    row = db_session.query(CloudProviderCredential).one()
    assert plaintext not in row.api_token_encrypted
    # Sanity: encrypt_secret produces Fernet output, which starts with 'gAAAA'.
    assert row.api_token_encrypted.startswith("gAAAA"), (
        "Expected Fernet-encrypted token; got something else"
    )


def test_create_writes_audit_event_without_token(client: TestClient, db_session):
    with _patch_verify(True, email="ops@example.com"):
        r = client.post("/api/integrations/cloud-providers", json={
            "provider": "hetzner",
            "api_token": "hetzner_TESTTOKEN_at_least_10",
        })
    assert r.status_code == 201
    cred_id = r.json()["id"]

    audit = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "cloud_provider.credential.create")
        .filter(AuditEvent.entity_id == UUID(cred_id))
        .one()
    )
    # Audit metadata MUST NOT contain the token. Verify exhaustively.
    assert "TESTTOKEN" not in (audit.extra_json or "")


# ── List + delete ───────────────────────────────────────────────────────────


def test_list_returns_caller_org_credentials(client: TestClient):
    with _patch_verify(True, email="ops@example.com"):
        client.post("/api/integrations/cloud-providers", json={
            "provider": "digitalocean",
            "api_token": "dop_v1_TOKEN_at_least_10",
            "label": "DO 1",
        })
        client.post("/api/integrations/cloud-providers", json={
            "provider": "hetzner",
            "api_token": "hetzner_TOKEN_at_least_10",
            "label": "Hetz 1",
        })

    r = client.get("/api/integrations/cloud-providers")
    assert r.status_code == 200
    rows = r.json()
    assert {r["provider"] for r in rows} == {"digitalocean", "hetzner"}
    # Token never appears in any list payload.
    assert all("api_token" not in row for row in rows)


def test_delete_removes_credential(client: TestClient, db_session):
    with _patch_verify(True, email="ops@example.com"):
        r = client.post("/api/integrations/cloud-providers", json={
            "provider": "digitalocean",
            "api_token": "dop_v1_TODELETE_at_least_10",
        })
    cred_id = r.json()["id"]
    d = client.delete(f"/api/integrations/cloud-providers/{cred_id}")
    assert d.status_code == 204
    assert db_session.query(CloudProviderCredential).filter(CloudProviderCredential.id == UUID(cred_id)).first() is None


# ── Re-verify ───────────────────────────────────────────────────────────────


def test_reverify_updates_last_verified_at_on_success(client: TestClient, db_session):
    with _patch_verify(True, email="ops@example.com"):
        r = client.post("/api/integrations/cloud-providers", json={
            "provider": "digitalocean",
            "api_token": "dop_v1_REVERIFY_at_least_10",
        })
    cred_id = r.json()["id"]
    before = db_session.query(CloudProviderCredential).filter(CloudProviderCredential.id == UUID(cred_id)).one().last_verified_at

    # Reverify with a fresh "ok"
    with _patch_verify(True, email="ops@example.com"):
        v = client.post(f"/api/integrations/cloud-providers/{cred_id}/verify")
    assert v.status_code == 200
    assert v.json()["ok"] is True

    db_session.expire_all()
    after = db_session.query(CloudProviderCredential).filter(CloudProviderCredential.id == UUID(cred_id)).one().last_verified_at
    assert after is not None
    # Either strictly greater (clock advanced) or equal (very fast).
    assert after >= before


def test_reverify_surfaces_error_without_updating_state(client: TestClient, db_session):
    """A failed re-verify shouldn't clobber a previously-valid
    last_verified_at — operators rely on that timestamp to know when
    the token last actually worked."""
    with _patch_verify(True, email="ops@example.com"):
        r = client.post("/api/integrations/cloud-providers", json={
            "provider": "digitalocean",
            "api_token": "dop_v1_OKTOKEN_at_least_10",
        })
    cred_id = r.json()["id"]
    last_ok = db_session.query(CloudProviderCredential).filter(CloudProviderCredential.id == UUID(cred_id)).one().last_verified_at

    with _patch_verify(False, error="DigitalOcean rejected the token (401)."):
        v = client.post(f"/api/integrations/cloud-providers/{cred_id}/verify")
    assert v.status_code == 200
    body = v.json()
    assert body["ok"] is False
    assert "401" in body["error"]

    # Timestamp from the original successful verify is preserved.
    db_session.expire_all()
    after = db_session.query(CloudProviderCredential).filter(CloudProviderCredential.id == UUID(cred_id)).one().last_verified_at
    assert after == last_ok
