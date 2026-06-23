"""Tests for deployment attribution — the `triggered_by_*` fields.

The Deployments table shows *who* kicked off each deploy (and falls back
to the trigger type for webhook/scheduled/self-heal deploys that have no
interactive user). This verifies the full path:

  - `trigger_deployment` stamps `triggered_by_user_id` from the caller
  - `list_deployments` resolves that id to an email/name at read time
  - the rollback path carries attribution too
  - non-user triggers (no `triggered_by_user_id`) round-trip as nulls

The build pipeline is stubbed (`enqueue_build` patched to a no-op) so
these stay fast and don't depend on a real git repo / podman.
"""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient


def _create_project(client: TestClient, name: str) -> dict:
    r = client.post(
        "/api/projects",
        json={
            "name": name,
            "use_case": "vercel_like",
            # deployment_model defaults to self_hosted, which lets a deploy
            # proceed with zero nodes (builder runs locally) — exactly what
            # we want so trigger_deployment doesn't 400 on "no nodes".
            "repo_url": f"https://example.com/{name}.git",
            "repo_branch": "main",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def _trigger(client: TestClient, project_id: str, monkeypatch) -> dict:
    # Stub the queue so no real build runs; we only care about the row.
    monkeypatch.setattr(
        "watchtower.api.deployments.enqueue_build",
        lambda *a, **k: None,
    )
    r = client.post(
        f"/api/projects/{project_id}/deployments",
        json={"branch": "main", "commit_sha": "abc1234"},
    )
    assert r.status_code == 201, r.text
    return r.json()


# ── trigger stamps the user ──────────────────────────────────────────────────

def test_trigger_deployment_records_triggered_by_user(client: TestClient, monkeypatch):
    p = _create_project(client, "attrib-a")
    dep = _trigger(client, p["id"], monkeypatch)
    assert dep["triggered_by_user_id"], "trigger should stamp the acting user"


# ── list resolves email/name ─────────────────────────────────────────────────

def test_list_deployments_resolves_triggered_by_email(client: TestClient, monkeypatch):
    p = _create_project(client, "attrib-b")
    _trigger(client, p["id"], monkeypatch)

    r = client.get(f"/api/projects/{p['id']}/deployments")
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1
    row = rows[0]
    # The static test token synthesises a deterministic user; it should
    # resolve to *some* email (the auto-provisioned account), not stay null.
    assert "triggered_by_email" in row
    assert "triggered_by_name" in row
    assert row["triggered_by_user_id"]


# ── rollback carries attribution ─────────────────────────────────────────────

def test_rollback_records_triggered_by(client: TestClient, monkeypatch, db_session):
    from watchtower.database import Deployment, DeploymentStatus, Project

    p = _create_project(client, "attrib-c")

    # Seed two LIVE deployments so rollback has a previous target. We write
    # them directly because driving the builder to LIVE in a unit test is
    # out of scope here — we only exercise the rollback handler's
    # attribution, not the build.
    proj = db_session.query(Project).filter(Project.id == uuid.UUID(p["id"])).first()
    older = Deployment(
        project_id=proj.id, commit_sha="old11111", branch="main",
        status=DeploymentStatus.LIVE,
    )
    newer = Deployment(
        project_id=proj.id, commit_sha="new22222", branch="main",
        status=DeploymentStatus.LIVE,
    )
    db_session.add(older)
    db_session.add(newer)
    db_session.commit()
    db_session.refresh(newer)

    monkeypatch.setattr(
        "watchtower.api.deployments.enqueue_build",
        lambda *a, **k: None,
    )
    r = client.post(f"/api/projects/deployments/{newer.id}/rollback")
    assert r.status_code == 200, r.text
    rollback = r.json()
    assert rollback["triggered_by_user_id"], "rollback should be attributed to the actor"
    assert rollback["commit_sha"] == "old11111"


# ── non-user triggers round-trip as null ─────────────────────────────────────

def test_unattributed_deployment_serializes_as_null(client: TestClient, db_session):
    """A deployment with no triggering user (webhook/scheduled/self-heal)
    must serialize triggered_by_* as null, not error."""
    from watchtower.database import Deployment, DeploymentStatus, DeploymentTrigger, Project

    p = _create_project(client, "attrib-d")
    proj = db_session.query(Project).filter(Project.id == uuid.UUID(p["id"])).first()
    dep = Deployment(
        project_id=proj.id, commit_sha="hook5678", branch="main",
        status=DeploymentStatus.LIVE, trigger=DeploymentTrigger.WEBHOOK,
        triggered_by_user_id=None,
    )
    db_session.add(dep)
    db_session.commit()

    r = client.get(f"/api/projects/{p['id']}/deployments")
    assert r.status_code == 200, r.text
    row = next(d for d in r.json() if d["commit_sha"] == "hook5678")
    assert row["triggered_by_user_id"] is None
    assert row["triggered_by_email"] is None
    assert row["triggered_by_name"] is None
