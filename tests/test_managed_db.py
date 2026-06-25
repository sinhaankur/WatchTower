"""Tests for /api/managed-databases.

Real podman/docker is never invoked — we monkeypatch the runtime
module so `_run` returns scripted (rc, stdout, stderr) tuples and
`_podman_path` returns a fake path.
"""
from __future__ import annotations

import pytest

from watchtower import managed_db_runtime as runtime
from watchtower.database import ManagedDatabase, ManagedDatabaseStatus


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def fake_podman(monkeypatch):
    """Pretend podman is installed and every command succeeds."""
    monkeypatch.setattr(runtime, "_podman_path", lambda: "/usr/bin/podman")

    def ok(cmd, *, timeout=60.0):
        # Inspect for pod state: return "Running" so refresh sees running pods.
        if "inspect" in cmd:
            return 0, "Running", ""
        return 0, "", ""

    monkeypatch.setattr(runtime, "_run", ok)
    return monkeypatch


@pytest.fixture
def no_podman(monkeypatch):
    monkeypatch.setattr(runtime, "_podman_path", lambda: None)
    return monkeypatch


# ── Auth ─────────────────────────────────────────────────────────────────────


def test_list_requires_auth(anon_client):
    assert anon_client.get("/api/managed-databases").status_code == 401


def test_create_requires_auth(anon_client):
    assert anon_client.post("/api/managed-databases", json={"name": "x"}).status_code == 401


# ── Runtime probe ────────────────────────────────────────────────────────────


def test_runtime_reports_available(client, fake_podman):
    r = client.get("/api/managed-databases/runtime")
    assert r.status_code == 200
    assert r.json() == {"available": True}


def test_runtime_reports_unavailable(client, no_podman):
    r = client.get("/api/managed-databases/runtime")
    assert r.status_code == 200
    assert r.json() == {"available": False}


# ── Create / list ────────────────────────────────────────────────────────────


def test_create_returns_credentials_once(client, fake_podman):
    r = client.post(
        "/api/managed-databases",
        json={"name": "blog-prod"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "blog-prod"
    assert body["engine"] == "postgres"
    assert body["version"] == "16"
    assert body["status"] == "running"
    assert body["port"] > 0
    assert body["password"]                # plaintext on create
    assert body["password"] in body["connection_string"]


def test_create_with_fixed_host_port_pins_and_persists(client, fake_podman, monkeypatch):
    """A pinned host_port is used verbatim (stable connection string) and
    persisted, instead of auto-picking a random port."""
    # The port-free check uses a real socket bind; force it True so the test
    # doesn't depend on 55432 actually being free on the CI host.
    monkeypatch.setattr(runtime, "is_port_free", lambda _p: True)
    r = client.post(
        "/api/managed-databases",
        json={"name": "pinned-db", "host_port": 55432},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["port"] == 55432
    assert ":55432/" in body["connection_string"]


def test_create_rejects_host_port_in_use(client, fake_podman, monkeypatch):
    """A pinned port that's already bound returns a clear 409, not a raw
    podman bind error."""
    monkeypatch.setattr(runtime, "is_port_free", lambda _p: False)
    r = client.post(
        "/api/managed-databases",
        json={"name": "busy-port-db", "host_port": 55432},
    )
    assert r.status_code == 409
    assert "in use" in r.json()["detail"].lower()


def test_create_without_host_port_auto_picks(client, fake_podman, monkeypatch):
    """Omitting host_port keeps the existing auto-pick behaviour."""
    monkeypatch.setattr(runtime, "pick_free_port", lambda: 54321)
    r = client.post(
        "/api/managed-databases",
        json={"name": "auto-port-db"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["port"] == 54321


def test_create_rejects_out_of_range_host_port(client, fake_podman):
    """host_port below 1024 is rejected by schema validation (422)."""
    r = client.post(
        "/api/managed-databases",
        json={"name": "lowport-db", "host_port": 80},
    )
    assert r.status_code == 422


def test_create_rejects_without_runtime(client, no_podman):
    r = client.post("/api/managed-databases", json={"name": "x"})
    assert r.status_code == 400
    assert "podman" in r.json()["detail"].lower()


def test_create_rejects_unsafe_name(client, fake_podman):
    r = client.post("/api/managed-databases", json={"name": "bad name; rm -rf /"})
    assert r.status_code == 422


def test_create_rejects_unknown_version(client, fake_podman):
    r = client.post(
        "/api/managed-databases",
        json={"name": "ok", "version": "9.0"},
    )
    assert r.status_code == 400
    assert "unsupported" in r.json()["detail"].lower()


def test_create_rejects_duplicate_name(client, fake_podman):
    r1 = client.post("/api/managed-databases", json={"name": "dup"})
    assert r1.status_code == 200
    r2 = client.post("/api/managed-databases", json={"name": "dup"})
    assert r2.status_code == 409


def test_create_failure_marks_row_failed_and_surfaces_error(
    client, db_session, monkeypatch,
):
    monkeypatch.setattr(runtime, "_podman_path", lambda: "/usr/bin/podman")

    def fail_on_pod_create(cmd, *, timeout=60.0):
        if cmd[1:3] == ["pod", "create"]:
            return 1, "", "name already in use"
        return 0, "", ""

    monkeypatch.setattr(runtime, "_run", fail_on_pod_create)

    r = client.post("/api/managed-databases", json={"name": "broken"})
    assert r.status_code == 400
    assert "name already in use" in r.json()["detail"]

    # Row should exist in FAILED state so the user can retry/delete.
    row = db_session.query(ManagedDatabase).filter(ManagedDatabase.name == "broken").first()
    assert row is not None
    assert row.status == ManagedDatabaseStatus.FAILED


def test_list_then_get_round_trip(client, fake_podman):
    cr = client.post("/api/managed-databases", json={"name": "alpha"})
    assert cr.status_code == 200
    db_id = cr.json()["id"]

    lst = client.get("/api/managed-databases")
    assert lst.status_code == 200
    rows = lst.json()
    assert len(rows) == 1
    assert rows[0]["name"] == "alpha"
    # Password must not leak through the list endpoint.
    assert "password" not in rows[0]

    got = client.get(f"/api/managed-databases/{db_id}")
    assert got.status_code == 200
    assert got.json()["id"] == db_id
    assert "password" not in got.json()


# ── Start / stop ─────────────────────────────────────────────────────────────


def test_stop_then_start_updates_status(client, fake_podman):
    cr = client.post("/api/managed-databases", json={"name": "lifecycle"})
    db_id = cr.json()["id"]

    stop = client.post(f"/api/managed-databases/{db_id}/stop")
    assert stop.status_code == 200
    assert stop.json()["status"] == "stopped"

    start = client.post(f"/api/managed-databases/{db_id}/start")
    assert start.status_code == 200
    assert start.json()["status"] == "running"


def test_start_surfaces_runtime_error(client, monkeypatch):
    monkeypatch.setattr(runtime, "_podman_path", lambda: "/usr/bin/podman")

    # Allow create to succeed.
    def script(cmd, *, timeout=60.0):
        if "inspect" in cmd:
            return 0, "Running", ""
        if cmd[1:3] == ["pod", "start"]:
            return 1, "", "no such pod"
        return 0, "", ""

    monkeypatch.setattr(runtime, "_run", script)

    cr = client.post("/api/managed-databases", json={"name": "starterr"})
    db_id = cr.json()["id"]
    r = client.post(f"/api/managed-databases/{db_id}/start")
    assert r.status_code == 400
    assert "no such pod" in r.json()["detail"]


# ── Credentials reveal ───────────────────────────────────────────────────────


def test_reveal_credentials_matches_create(client, fake_podman):
    cr = client.post("/api/managed-databases", json={"name": "secret-test"})
    body = cr.json()
    db_id = body["id"]
    plaintext = body["password"]

    rev = client.get(f"/api/managed-databases/{db_id}/credentials")
    assert rev.status_code == 200
    assert rev.json()["password"] == plaintext
    assert plaintext in rev.json()["connection_string"]


def test_reveal_writes_audit(client, db_session, fake_podman):
    from watchtower.database import AuditEvent

    cr = client.post("/api/managed-databases", json={"name": "audit-creds"})
    db_id = cr.json()["id"]
    client.get(f"/api/managed-databases/{db_id}/credentials")

    events = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "managed_db.credentials.view")
        .all()
    )
    assert len(events) == 1


# ── Delete ───────────────────────────────────────────────────────────────────


def test_delete_removes_row(client, db_session, fake_podman):
    from uuid import UUID

    cr = client.post("/api/managed-databases", json={"name": "doomed"})
    db_id = cr.json()["id"]

    r = client.delete(f"/api/managed-databases/{db_id}")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "id": db_id, "purged_volume": False}

    # SQLAlchemy's Uuid(as_uuid=True) column needs a UUID object on the
    # right-hand side — the str from the JSON response would call .hex
    # on a str, blowing up before the query runs.
    assert db_session.query(ManagedDatabase).filter(
        ManagedDatabase.id == UUID(db_id)
    ).first() is None


def test_delete_with_purge_passes_flag(client, db_session, monkeypatch):
    monkeypatch.setattr(runtime, "_podman_path", lambda: "/usr/bin/podman")
    calls: list[list[str]] = []

    def record(cmd, *, timeout=60.0):
        calls.append(cmd)
        if "inspect" in cmd:
            return 0, "Running", ""
        return 0, "", ""

    monkeypatch.setattr(runtime, "_run", record)

    cr = client.post("/api/managed-databases", json={"name": "wipe-me"})
    db_id = cr.json()["id"]
    r = client.delete(f"/api/managed-databases/{db_id}?purge=true")
    assert r.status_code == 200
    assert r.json()["purged_volume"] is True

    # The delete path must have invoked `volume rm` when purge=true.
    assert any(cmd[1:3] == ["volume", "rm"] for cmd in calls)


# ── Audit on create ──────────────────────────────────────────────────────────


def test_create_writes_audit(client, db_session, fake_podman):
    from watchtower.database import AuditEvent

    client.post("/api/managed-databases", json={"name": "audited"})
    events = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "managed_db.create")
        .all()
    )
    assert len(events) == 1
    assert events[0].entity_type == "managed_database"


# ── Multi-engine ─────────────────────────────────────────────────────────────


def test_engines_catalogue_returns_supported_set(client, fake_podman):
    r = client.get("/api/managed-databases/engines")
    assert r.status_code == 200
    catalogue = r.json()
    ids = {e["id"] for e in catalogue}
    # v0+ supports these. Adding more should grow this set, never shrink it.
    assert {"postgres", "mysql", "mariadb", "mongodb", "redis"}.issubset(ids)
    for engine in catalogue:
        assert engine["versions"], f"{engine['id']} has no versions"


def test_create_mysql(client, fake_podman):
    r = client.post(
        "/api/managed-databases",
        json={"name": "mydb", "engine": "mysql", "version": "8.0"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["engine"] == "mysql"
    assert body["connection_string"].startswith("mysql://")


def test_create_mongodb(client, fake_podman):
    r = client.post(
        "/api/managed-databases",
        json={"name": "mongo1", "engine": "mongodb", "version": "7.0"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["connection_string"].startswith("mongodb://")


def test_create_redis_omits_db_and_user_in_connection(client, fake_podman):
    r = client.post(
        "/api/managed-databases",
        json={"name": "cache1", "engine": "redis", "version": "7.4"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    conn = body["connection_string"]
    # Redis URL: redis://:<password>@host:port (no user, no db path)
    assert conn.startswith("redis://:")
    # No path after host:port.
    assert conn.rstrip("/").count("/") == 2  # "redis://" has two slashes; nothing more


def test_create_rejects_unknown_engine(client, fake_podman):
    r = client.post(
        "/api/managed-databases",
        json={"name": "weird", "engine": "oracle", "version": "21c"},
    )
    assert r.status_code == 400
    assert "unsupported engine" in r.json()["detail"].lower()


def test_create_rejects_version_mismatch(client, fake_podman):
    r = client.post(
        "/api/managed-databases",
        json={"name": "x", "engine": "mysql", "version": "16"},  # postgres-style version
    )
    assert r.status_code == 400
    assert "unsupported mysql version" in r.json()["detail"].lower()
