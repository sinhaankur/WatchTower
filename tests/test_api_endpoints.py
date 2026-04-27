"""Smoke tests for the WatchTower FastAPI surface.

Covers: health, auth gate, project CRUD, related-app endpoints, run-with-related,
and webhook signature verification. Each test starts with a clean DB
(see ``conftest._clean_tables``).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid

from fastapi.testclient import TestClient


# ── Helpers ──────────────────────────────────────────────────────────────────

def _create_project(client: TestClient, name: str, repo: str = "https://example.com/x.git") -> dict:
    r = client.post(
        "/api/projects",
        json={
            "name": name,
            "use_case": "vercel_like",
            "repo_url": repo,
            "repo_branch": "main",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


# ── Health ───────────────────────────────────────────────────────────────────

def test_health_returns_200(anon_client: TestClient):
    r = anon_client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "healthy"


def test_api_health_alias_returns_200(anon_client: TestClient):
    """The /api/health alias is what the SPA's apiClient hits."""
    r = anon_client.get("/api/health")
    assert r.status_code == 200


# ── Auth gate ────────────────────────────────────────────────────────────────

def test_unauthenticated_request_returns_401(anon_client: TestClient):
    r = anon_client.get("/api/projects")
    assert r.status_code == 401


def test_invalid_token_returns_401(anon_client: TestClient):
    r = anon_client.get(
        "/api/projects",
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert r.status_code == 401


def test_missing_bearer_prefix_returns_401(anon_client: TestClient):
    r = anon_client.get(
        "/api/projects",
        headers={"Authorization": "test-token"},  # no "Bearer " prefix
    )
    assert r.status_code == 401


# ── Project CRUD ─────────────────────────────────────────────────────────────

def test_create_and_list_project(client: TestClient):
    p = _create_project(client, "alpha")
    assert p["name"] == "alpha"
    assert "id" in p and "webhook_secret" not in p  # secret is server-side only

    r = client.get("/api/projects")
    assert r.status_code == 200
    names = [proj["name"] for proj in r.json()]
    assert "alpha" in names


def test_get_project_by_id(client: TestClient):
    p = _create_project(client, "beta")
    r = client.get(f"/api/projects/{p['id']}")
    assert r.status_code == 200
    assert r.json()["id"] == p["id"]


def test_get_unknown_project_returns_404(client: TestClient):
    bogus = uuid.uuid4()
    r = client.get(f"/api/projects/{bogus}")
    assert r.status_code == 404


def test_get_project_with_invalid_uuid_returns_422(client: TestClient):
    """Validation should produce 422, not a 500 from a bare UUID() raise."""
    r = client.get("/api/projects/not-a-uuid")
    assert r.status_code == 422


def test_delete_project(client: TestClient):
    p = _create_project(client, "gamma")
    r = client.delete(f"/api/projects/{p['id']}")
    assert r.status_code == 204
    assert client.get(f"/api/projects/{p['id']}").status_code == 404


# ── Related-app endpoints ────────────────────────────────────────────────────

def test_related_self_link_rejected(client: TestClient):
    p = _create_project(client, "self")
    r = client.post(
        f"/api/projects/{p['id']}/related",
        json={"related_project_id": p["id"]},
    )
    assert r.status_code == 400
    assert "self" in r.json()["detail"].lower()


def test_related_unknown_project_rejected(client: TestClient):
    p = _create_project(client, "unknown")
    r = client.post(
        f"/api/projects/{p['id']}/related",
        json={"related_project_id": str(uuid.uuid4())},
    )
    assert r.status_code == 404


def test_related_duplicate_rejected_with_409(client: TestClient):
    p1 = _create_project(client, "p1", "https://example.com/p1.git")
    p2 = _create_project(client, "p2", "https://example.com/p2.git")
    first = client.post(f"/api/projects/{p1['id']}/related", json={"related_project_id": p2["id"]})
    assert first.status_code == 201
    dup = client.post(f"/api/projects/{p1['id']}/related", json={"related_project_id": p2["id"]})
    assert dup.status_code == 409


def test_related_list_orders_by_index_then_creation(client: TestClient):
    p1 = _create_project(client, "trigger", "https://example.com/t.git")
    p2 = _create_project(client, "dep-low", "https://example.com/lo.git")
    p3 = _create_project(client, "dep-high", "https://example.com/hi.git")
    # Insert in reverse order to confirm sort isn't accidental.
    client.post(f"/api/projects/{p1['id']}/related",
                json={"related_project_id": p2["id"], "order_index": 5})
    client.post(f"/api/projects/{p1['id']}/related",
                json={"related_project_id": p3["id"], "order_index": 1})

    r = client.get(f"/api/projects/{p1['id']}/related")
    assert r.status_code == 200
    ordered_names = [row["related_project_name"] for row in r.json()]
    assert ordered_names == ["dep-high", "dep-low"]


def test_related_remove_returns_204(client: TestClient):
    p1 = _create_project(client, "p1", "https://example.com/p1.git")
    p2 = _create_project(client, "p2", "https://example.com/p2.git")
    client.post(f"/api/projects/{p1['id']}/related", json={"related_project_id": p2["id"]})
    r = client.delete(f"/api/projects/{p1['id']}/related/{p2['id']}")
    assert r.status_code == 204
    listing = client.get(f"/api/projects/{p1['id']}/related").json()
    assert listing == []


def test_run_with_related_queues_in_order(client: TestClient):
    """Dependencies first (sorted by order_index), trigger last."""
    p1 = _create_project(client, "trigger", "https://example.com/t.git")
    p2 = _create_project(client, "dep-a", "https://example.com/a.git")
    p3 = _create_project(client, "dep-b", "https://example.com/b.git")
    client.post(f"/api/projects/{p1['id']}/related",
                json={"related_project_id": p2["id"], "order_index": 10})
    client.post(f"/api/projects/{p1['id']}/related",
                json={"related_project_id": p3["id"], "order_index": 1})

    r = client.post(f"/api/projects/{p1['id']}/run-with-related")
    assert r.status_code == 200
    body = r.json()
    assert body["triggered_count"] == 3
    assert body["skipped_count"] == 0
    queued = [item["project_name"] for item in body["results"] if item["status"] == "queued"]
    assert queued == ["dep-b", "dep-a", "trigger"]


# ── Webhook ──────────────────────────────────────────────────────────────────

def _sign(body: bytes, secret: str) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_webhook_unsigned_returns_401(anon_client: TestClient, client: TestClient):
    p = _create_project(client, "wh1")
    r = anon_client.post(f"/api/webhooks/github/{p['id']}", json={"ref": "refs/heads/main"})
    assert r.status_code == 401


def test_webhook_bad_signature_returns_401(anon_client: TestClient, client: TestClient, db_session):
    p = _create_project(client, "wh2")
    body = json.dumps({"ref": "refs/heads/main"}).encode()
    r = anon_client.post(
        f"/api/webhooks/github/{p['id']}",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Hub-Signature-256": "sha256=" + ("0" * 64),
            "X-GitHub-Delivery": str(uuid.uuid4()),
        },
    )
    assert r.status_code == 401


def test_webhook_valid_signature_accepts(anon_client: TestClient, client: TestClient, db_session):
    """Build the same HMAC the project's secret expects, then post."""
    from watchtower.database import Project
    p = _create_project(client, "wh3")
    project_row = db_session.query(Project).filter(Project.id == uuid.UUID(p["id"])).one()
    secret = project_row.webhook_secret

    body = json.dumps({
        "ref": "refs/heads/main",
        "after": "deadbeef" * 5,
        "head_commit": {"id": "deadbeef" * 5, "message": "test"},
    }).encode()
    r = anon_client.post(
        f"/api/webhooks/github/{p['id']}",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Hub-Signature-256": _sign(body, secret),
            "X-GitHub-Delivery": str(uuid.uuid4()),
        },
    )
    # Either queued (success) or replay-cached — both >= 200, < 400.
    assert r.status_code < 400, r.text


def test_webhook_replay_rejected(anon_client: TestClient, client: TestClient, db_session):
    """The same X-GitHub-Delivery cannot be processed twice."""
    from watchtower.database import Project
    p = _create_project(client, "wh4")
    project_row = db_session.query(Project).filter(Project.id == uuid.UUID(p["id"])).one()
    secret = project_row.webhook_secret

    body = json.dumps({
        "ref": "refs/heads/main",
        "after": "cafef00d" * 5,
        "head_commit": {"id": "cafef00d" * 5, "message": "replay"},
    }).encode()
    delivery = str(uuid.uuid4())
    headers = {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": _sign(body, secret),
        "X-GitHub-Delivery": delivery,
    }
    first = anon_client.post(f"/api/webhooks/github/{p['id']}", data=body, headers=headers)
    assert first.status_code < 400
    second = anon_client.post(f"/api/webhooks/github/{p['id']}", data=body, headers=headers)
    # Replay either returns "Duplicate delivery ignored" (200) or is silently
    # absorbed; the contract is "no second deployment is queued."
    assert second.status_code == 200
    assert "duplicate" in second.json()["message"].lower()
