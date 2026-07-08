"""GET /api/external-databases/discover — adopt existing local databases.

Surfaces DB containers already running on the host (that WatchTower didn't
create) as one-click adoption candidates. We monkeypatch
podman_runtime.list_containers so no real podman is needed.
"""
from __future__ import annotations

import pytest

from watchtower import podman_runtime
from watchtower.api.external_db import _classify_engine


def _container(name, image, *, host_port=None, managed=False, state="running"):
    ports = [{"host": host_port, "container": 5432}] if host_port else []
    return {
        "id": name[:12], "name": name, "image": image, "state": state,
        "status": "Up", "pod": None, "created": "now", "ports": ports,
        "managed": managed, "project_id": None, "project_name": None,
    }


# ── classifier unit ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("image, engine", [
    ("docker.io/library/postgres:16-alpine", "postgres"),
    ("postgres:15", "postgres"),
    ("mariadb:11", "mariadb"),
    ("mysql:8", "mysql"),
    ("mongo:7", "mongodb"),
    ("redis:7-alpine", "redis"),
    ("valkey/valkey:8", "redis"),
    ("nginx:alpine", None),
    ("ghcr.io/me/myapp:latest", None),
])
def test_classify_engine(image, engine):
    assert _classify_engine(image) == engine


# ── endpoint ─────────────────────────────────────────────────────────────────


def test_discover_requires_auth(anon_client):
    assert anon_client.get("/api/external-databases/discover").status_code == 401


def test_discover_returns_db_candidates(client, monkeypatch):
    monkeypatch.setattr(podman_runtime, "list_containers", lambda: [
        _container("pg-data", "postgres:16", host_port=5432),
        _container("web", "nginx:alpine"),                 # not a DB → excluded
        _container("wt-managed", "postgres:16", host_port=5500, managed=True),  # ours → excluded
        _container("cache", "redis:7", host_port=6379),
    ])
    r = client.get("/api/external-databases/discover")
    assert r.status_code == 200, r.text
    names = {c["container_name"] for c in r.json()}
    assert names == {"pg-data", "cache"}  # nginx + managed excluded


def test_discover_classifies_engine_and_port(client, monkeypatch):
    monkeypatch.setattr(podman_runtime, "list_containers", lambda: [
        _container("pg-data", "docker.io/library/postgres:16-alpine", host_port=5433),
    ])
    body = client.get("/api/external-databases/discover").json()
    assert len(body) == 1
    c = body[0]
    assert c["engine"] == "postgres"
    assert c["suggested_port"] == 5433
    assert c["suggested_host"] == "127.0.0.1"
    assert c["suggested_username"]  # default user from the engine catalogue


def test_discover_flags_already_connected(client, db_session, monkeypatch):
    # First register an external DB on 127.0.0.1:5432 …
    r = client.post("/api/external-databases", json={
        "name": "existing", "engine": "postgres",
        "host": "127.0.0.1", "port": 5432,
    })
    assert r.status_code == 200, r.text
    # … then discovery should flag the matching container as already_connected.
    monkeypatch.setattr(podman_runtime, "list_containers", lambda: [
        _container("pg-data", "postgres:16", host_port=5432),
    ])
    body = client.get("/api/external-databases/discover").json()
    assert body[0]["already_connected"] is True


def test_discover_empty_when_no_runtime(client, monkeypatch):
    def boom():
        raise RuntimeError("no podman")
    monkeypatch.setattr(podman_runtime, "list_containers", boom)
    r = client.get("/api/external-databases/discover")
    assert r.status_code == 200
    assert r.json() == []
