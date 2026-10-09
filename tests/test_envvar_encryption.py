"""Environment-variable values are encrypted at rest.

Env vars routinely hold secrets (API keys, DB passwords). The raw value must
never sit in the SQLite file as plaintext — only ciphertext on disk, with
decryption on read and on deploy-injection. Legacy plaintext rows (written
before encryption landed) must remain readable and self-heal to ciphertext.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from watchtower.database import EnvironmentVariable
from watchtower.api.envvars import enc_value, dec_value


def _create_project(client: TestClient, name: str = "env-proj") -> dict:
    r = client.post("/api/projects", json={
        "name": name, "use_case": "vercel_like",
        "repo_url": "https://example.com/x.git", "repo_branch": "main",
    })
    assert r.status_code == 201, r.text
    return r.json()


# ── helper round-trip ─────────────────────────────────────────────────────────

def test_enc_dec_roundtrip():
    secret = "super-secret-db-password-123"
    stored = enc_value(secret)
    assert stored != secret            # actually encrypted
    assert dec_value(stored) == secret  # round-trips


def test_dec_tolerates_legacy_plaintext():
    # A row written before encryption: raw plaintext. dec_value must return it
    # unchanged rather than raising, so old installs keep deploying.
    assert dec_value("plain-old-value") == "plain-old-value"


def test_dec_handles_none():
    assert dec_value(None) == ""


# ── at-rest: the DB row must hold ciphertext, not the secret ──────────────────

def test_created_env_var_is_ciphertext_on_disk(client: TestClient, db_session):
    proj = _create_project(client, "enc-at-rest")
    secret = "AKIA-not-a-real-key-EXAMPLE"
    r = client.post(f"/api/projects/{proj['id']}/env", json={
        "key": "AWS_SECRET", "value": secret, "environment": "production",
    })
    assert r.status_code == 201, r.text
    # API echoes the real value back on create.
    assert r.json()["value"] == secret

    # But on disk it must be ciphertext.
    row = db_session.query(EnvironmentVariable).filter_by(key="AWS_SECRET").first()
    assert row is not None
    assert row.value != secret, "env-var value stored as PLAINTEXT — privacy regression"
    assert dec_value(row.value) == secret


def test_list_masks_decrypted_value(client: TestClient):
    proj = _create_project(client, "enc-list")
    client.post(f"/api/projects/{proj['id']}/env", json={
        "key": "TOKEN", "value": "abcdefgh1234", "environment": "production",
    })
    r = client.get(f"/api/projects/{proj['id']}/env")
    assert r.status_code == 200
    row = next(e for e in r.json() if e["key"] == "TOKEN")
    # Masked (last 4 shown) and derived from the DECRYPTED value, not ciphertext.
    assert row["value"].endswith("1234")
    assert row["value"].startswith("*")


def test_update_reencrypts(client: TestClient, db_session):
    proj = _create_project(client, "enc-update")
    create = client.post(f"/api/projects/{proj['id']}/env", json={
        "key": "K", "value": "first", "environment": "production",
    })
    ev_id = create.json()["id"]
    upd = client.put(f"/api/projects/{proj['id']}/env/{ev_id}", json={"value": "second"})
    assert upd.status_code == 200
    assert upd.json()["value"] == "second"
    row = db_session.query(EnvironmentVariable).filter_by(key="K").first()
    assert row.value != "second"
    assert dec_value(row.value) == "second"


# ── deploy injection decrypts ─────────────────────────────────────────────────
# _load_env_vars only reads project.id, so a tiny stub avoids an ORM Project
# requery (and the cross-session lazy-load flakiness that comes with it).

class _ProjStub:
    def __init__(self, pid):
        self.id = pid


def test_deploy_injection_decrypts(client: TestClient, db_session):
    """The deploy path (_load_env_vars) must inject the real value, not
    ciphertext — otherwise the deployed app gets a garbage env var."""
    from watchtower import builder
    import uuid as _uuid

    proj = _create_project(client, "enc-deploy")
    client.post(f"/api/projects/{proj['id']}/env", json={
        "key": "DATABASE_URL", "value": "postgres://u:p@h/db", "environment": "production",
    })
    env = builder._load_env_vars(db_session, _ProjStub(_uuid.UUID(proj["id"])))
    assert env["DATABASE_URL"] == "postgres://u:p@h/db"


def test_legacy_plaintext_row_still_deploys(client: TestClient, db_session):
    """A plaintext row written before encryption must still inject correctly."""
    from watchtower import builder
    import uuid as _uuid

    proj = _create_project(client, "enc-legacy")
    pid = _uuid.UUID(proj["id"])
    # Simulate a pre-encryption row: write plaintext directly.
    db_session.add(EnvironmentVariable(
        project_id=pid, key="LEGACY", value="plaintext-secret", environment="production",
    ))
    db_session.commit()
    env = builder._load_env_vars(db_session, _ProjStub(pid))
    assert env["LEGACY"] == "plaintext-secret"
