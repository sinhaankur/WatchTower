"""Tests for /api/external-databases — bring-your-own-DB connection storage."""
from __future__ import annotations

from watchtower.database import ExternalDatabase


def test_list_requires_auth(anon_client):
    assert anon_client.get("/api/external-databases").status_code == 401


def test_create_minimal(client):
    r = client.post(
        "/api/external-databases",
        json={"name": "rds-prod", "engine": "postgres", "host": "db.example.com", "port": 5432},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "rds-prod"
    assert body["engine"] == "postgres"
    assert body["has_password"] is False  # nothing supplied


def test_create_with_password_stores_encrypted(client, db_session):
    r = client.post(
        "/api/external-databases",
        json={
            "name": "external-pg",
            "engine": "postgres",
            "host": "10.0.0.5",
            "port": 5432,
            "database_name": "appdb",
            "username": "reader",
            "password": "s3cret-pw",
            "use_tls": True,
        },
    )
    assert r.status_code == 200
    row = db_session.query(ExternalDatabase).filter(ExternalDatabase.name == "external-pg").first()
    assert row is not None
    # Stored value must be the Fernet ciphertext, not plaintext.
    assert row.password_encrypted
    assert row.password_encrypted != "s3cret-pw"


def test_create_rejects_unknown_engine(client):
    r = client.post(
        "/api/external-databases",
        json={"name": "weird", "engine": "oracle", "host": "h", "port": 1521},
    )
    assert r.status_code == 400


def test_create_rejects_duplicate_name(client):
    p = {"name": "dup", "engine": "postgres", "host": "h", "port": 5432}
    assert client.post("/api/external-databases", json=p).status_code == 200
    assert client.post("/api/external-databases", json=p).status_code == 409


# ── /test — browser connect-and-verify (Supabase / Neon / any Postgres) ────────


def test_test_connection_requires_auth(anon_client):
    assert anon_client.post("/api/external-databases/test", json={}).status_code == 401


def test_test_connection_needs_an_engine(client):
    """Nothing to go on → clear guidance, not a crash."""
    r = client.post("/api/external-databases/test", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert body["detail"] == "unknown_engine"


def test_test_connection_parses_connection_string(client):
    """A pasted hosted URL that can't actually be reached still parses: we
    learn the engine + host from it and fail with a real connection error,
    proving the string was understood (not rejected as unparseable)."""
    r = client.post(
        "/api/external-databases/test",
        json={"connection_string": "postgresql://u:p@db.nonexistent.invalid:5432/app"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["engine"] == "postgres"      # engine inferred from the URL
    assert body["ok"] is False               # host is unreachable
    assert body["detail"] != "unknown_engine"
    assert body["message"]                   # a human message, always


def test_test_connection_unsupported_engine_is_honest(client):
    """A recognised engine we can't probe from here says so — never a fake green."""
    r = client.post(
        "/api/external-databases/test",
        json={"engine": "mongodb", "host": "db.example.com", "port": 27017},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert body["detail"] in ("unsupported_engine", "driver_missing")
    assert "save" in body["message"].lower()  # tells them they can still save it


def test_credentials_reveal_returns_plaintext_and_audits(client, db_session):
    from watchtower.database import AuditEvent

    cr = client.post(
        "/api/external-databases",
        json={
            "name": "creds-test",
            "engine": "postgres",
            "host": "h",
            "port": 5432,
            "database_name": "app",
            "username": "u",
            "password": "topsecret",
        },
    )
    db_id = cr.json()["id"]

    rev = client.get(f"/api/external-databases/{db_id}/credentials")
    assert rev.status_code == 200
    assert rev.json()["password"] == "topsecret"
    assert "topsecret" in rev.json()["connection_string"]

    events = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "external_db.credentials.view")
        .all()
    )
    assert len(events) == 1


def test_credentials_for_redis_skips_userinfo_and_db_path(client):
    cr = client.post(
        "/api/external-databases",
        json={
            "name": "ext-redis",
            "engine": "redis",
            "host": "cache.example.com",
            "port": 6379,
            "password": "redispw",
        },
    )
    db_id = cr.json()["id"]
    rev = client.get(f"/api/external-databases/{db_id}/credentials")
    conn = rev.json()["connection_string"]
    assert conn.startswith("redis://:")
    assert "cache.example.com:6379" in conn
    # No trailing /db path for Redis URLs.
    assert not conn.endswith("/")


def test_patch_updates_subset(client, db_session):
    cr = client.post(
        "/api/external-databases",
        json={"name": "patch-me", "engine": "postgres", "host": "h", "port": 5432},
    )
    db_id = cr.json()["id"]
    r = client.patch(
        f"/api/external-databases/{db_id}",
        json={"host": "newhost.example.com", "notes": "moved"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["host"] == "newhost.example.com"
    assert body["notes"] == "moved"
    # Untouched fields preserved.
    assert body["port"] == 5432


def test_delete_removes_row(client, db_session):
    from uuid import UUID

    cr = client.post(
        "/api/external-databases",
        json={"name": "doomed-ext", "engine": "postgres", "host": "h", "port": 5432},
    )
    db_id = cr.json()["id"]
    r = client.delete(f"/api/external-databases/{db_id}")
    assert r.status_code == 200
    assert db_session.query(ExternalDatabase).filter(
        ExternalDatabase.id == UUID(db_id)
    ).first() is None


def test_password_never_leaks_in_list(client):
    client.post(
        "/api/external-databases",
        json={"name": "list-test", "engine": "postgres", "host": "h", "port": 5432, "password": "p"},
    )
    r = client.get("/api/external-databases")
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1
    assert "password" not in rows[0]
    assert "password_encrypted" not in rows[0]
    assert rows[0]["has_password"] is True
