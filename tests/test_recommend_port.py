"""Tests for ``GET /api/runtime/recommend-port``.

The wizard fetches a port suggestion at create time and the local-podman
runner consumes it as the source of truth at deploy time. The endpoint
must:

  - return a free port in the 3000-3999 range
  - skip ports the caller explicitly excludes
  - skip ports already assigned to other Projects owned by the caller
  - return 503 if the whole range is unavailable
  - require auth
"""
from __future__ import annotations

import socket
import uuid

import pytest

from watchtower.api import util as _util
from watchtower.database import Project, ProjectSourceType, UseCaseType


def _seed_project(db, *, owner_id, recommended_port: int | None, name="proj") -> Project:
    project = Project(
        name=name,
        use_case=UseCaseType.DOCKER_PLATFORM,
        source_type=ProjectSourceType.GITHUB.value,
        repo_url="https://github.com/example/repo",
        repo_branch="main",
        webhook_secret="test-secret",
        recommended_port=recommended_port,
        org_id=uuid.uuid4(),  # not the user's canonical org — see comment below
        owner_id=owner_id,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _occupy_port() -> tuple[socket.socket, int]:
    """Bind a real socket so an OS-level probe actually fails. Caller is
    responsible for closing — if you forget, pytest cleans the fd at exit
    but the next test sees a brief TIME_WAIT.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))  # let the OS pick
    s.listen(1)
    return s, s.getsockname()[1]


def test_recommend_port_returns_a_free_port_in_range(client):
    resp = client.get("/api/runtime/recommend-port")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert 3000 <= data["port"] <= 3999
    assert data["range_start"] == 3000
    assert data["range_end"] == 3999

    # Sanity check: the returned port should actually be bindable right
    # now. (Race possible — but if the OS hands us a port we can bind, the
    # endpoint did its job.)
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", data["port"]))
    finally:
        s.close()


def test_recommend_port_honors_exclude_param(client):
    """Pass three sequential ports in `exclude=`; the recommended port must
    not be one of them. This is the wizard's "user dismissed the first
    suggestion, give me another" flow.
    """
    excluded_str = "3000,3001,3002"
    resp = client.get(f"/api/runtime/recommend-port?exclude={excluded_str}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["port"] not in {3000, 3001, 3002}


def test_recommend_port_skips_garbage_in_exclude_param(client):
    """Bad input shouldn't crash — silently drop non-int / out-of-range
    values. (The wizard could send a stray comma or empty string.)
    """
    resp = client.get("/api/runtime/recommend-port?exclude=3000,abc,,99999,-1")
    assert resp.status_code == 200, resp.text
    assert resp.json()["port"] != 3000


def test_recommend_port_skips_ports_already_assigned_to_caller_projects(client, db_session):
    """If the user's existing projects have ports 3000+3001 reserved, the
    new suggestion should skip them so two projects don't collide on the
    recommended port (which would surprise the user even before either is
    deployed).
    """
    # The static-token canonical user the test fixture sets up.
    canonical = _util.canonical_user_id(
        db_session,
        {
            "user_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "watchtower:test-token")),
            "email": "developer@watchtower.local",
        },
    )
    # `_ensure_user_org_member` may not have created the user yet if no
    # endpoint has been hit — synthesize one so the join in the endpoint
    # finds something.
    _seed_project(db_session, owner_id=canonical, recommended_port=3000, name="project-a")
    _seed_project(db_session, owner_id=canonical, recommended_port=3001, name="project-b")

    resp = client.get("/api/runtime/recommend-port")
    assert resp.status_code == 200, resp.text
    assert resp.json()["port"] not in {3000, 3001}


def test_recommend_port_returns_503_when_range_exhausted(client, monkeypatch):
    """Every port unavailable → 503 with an actionable message. Mocks the
    bind probe rather than actually occupying 1000 ports.
    """
    from watchtower.api import runtime as _runtime

    monkeypatch.setattr(_runtime, "_is_port_free", lambda _p: False)

    resp = client.get("/api/runtime/recommend-port")
    assert resp.status_code == 503
    detail = resp.json()["detail"]
    assert "3000" in detail and "3999" in detail


def test_recommend_port_requires_auth(anon_client):
    resp = anon_client.get("/api/runtime/recommend-port")
    assert resp.status_code == 401
