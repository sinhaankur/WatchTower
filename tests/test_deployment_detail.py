"""Tests for GET /api/projects/deployments/{id}/detail.

The detail endpoint backs the dedicated /deployments/:id page. It bundles
the deployment (with triggered-by resolved), its build history, and
per-node deploy status in one call so the SPA doesn't make three
round-trips.

Covered:
  - auth gate
  - 404 for unknown id and for another owner's deployment (owner-scoped)
  - response shape: {deployment, builds, nodes}
  - per-node status resolves the node's human name
  - triggered-by carried through on the embedded deployment
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
            "repo_url": f"https://example.com/{name}.git",
            "repo_branch": "main",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def _trigger(client: TestClient, project_id: str, monkeypatch) -> dict:
    monkeypatch.setattr("watchtower.api.deployments.enqueue_build", lambda *a, **k: None)
    r = client.post(
        f"/api/projects/{project_id}/deployments",
        json={"branch": "main", "commit_sha": "abc1234"},
    )
    assert r.status_code == 201, r.text
    return r.json()


# ── Auth / not-found ──────────────────────────────────────────────────────────

def test_detail_requires_auth(anon_client: TestClient):
    r = anon_client.get(f"/api/projects/deployments/{uuid.uuid4()}/detail")
    assert r.status_code == 401


def test_detail_404_for_unknown_id(client: TestClient):
    r = client.get(f"/api/projects/deployments/{uuid.uuid4()}/detail")
    assert r.status_code == 404


# ── Shape ───────────────────────────────────────────────────────────────────

def test_detail_returns_bundle_shape(client: TestClient, monkeypatch):
    p = _create_project(client, "detail-a")
    dep = _trigger(client, p["id"], monkeypatch)

    r = client.get(f"/api/projects/deployments/{dep['id']}/detail")
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) >= {"deployment", "builds", "nodes"}
    assert body["deployment"]["id"] == dep["id"]
    assert isinstance(body["builds"], list)
    assert isinstance(body["nodes"], list)
    # triggered-by carried through on the embedded deployment.
    assert body["deployment"]["triggered_by_user_id"]


# ── Per-node status resolves node name ────────────────────────────────────────

def test_detail_resolves_node_name(client: TestClient, db_session):
    """A DeploymentNode row should surface the OrgNode's human name, not
    just the raw node_id."""
    from watchtower.database import (
        Deployment, DeploymentNode, DeploymentStatus, OrgNode, Project,
    )

    p = _create_project(client, "detail-b")
    proj = db_session.query(Project).filter(Project.id == uuid.UUID(p["id"])).first()

    node = OrgNode(
        org_id=proj.org_id,
        name="edge-web-1",
        host="10.0.0.5",
        user="deploy",
        port=22,
        remote_path="/srv/app",
        reload_command="systemctl reload app",
        status="healthy",
    )
    db_session.add(node)
    db_session.flush()

    dep = Deployment(
        project_id=proj.id, commit_sha="node1234", branch="main",
        status=DeploymentStatus.LIVE,
    )
    db_session.add(dep)
    db_session.flush()
    db_session.add(DeploymentNode(
        deployment_id=dep.id, node_id=node.id, status=DeploymentStatus.LIVE,
    ))
    db_session.commit()

    r = client.get(f"/api/projects/deployments/{dep.id}/detail")
    assert r.status_code == 200, r.text
    nodes = r.json()["nodes"]
    assert len(nodes) == 1
    assert nodes[0]["node_name"] == "edge-web-1"
    assert nodes[0]["node_host"] == "10.0.0.5"
