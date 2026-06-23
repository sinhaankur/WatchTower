"""Tests for the Go Live orchestration endpoint.

POST /api/projects/{id}/go-live chains existing steps (container deploy →
domain → Cloudflare DNS/Tunnel → autonomous) into one guided action and
returns a per-step checklist. These verify the orchestration wiring, not
the individual engines (those have their own tests):

  - auth + permission gates, unknown project 404
  - runs every step and returns a step list with an overall verdict
  - DNS mode calls sync_a_record (patched) and records the result on the domain
  - tunnel mode returns 'manual' guided steps without failing the whole run
  - enables run_as_container + autonomous_mode + sets live_url

The build queue is stubbed so no real deploy runs.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import patch

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


def _seed_node_and_cred(db_session, project_id: str):
    """Give the project's org an active node with a host + a Cloudflare
    credential so DNS mode has everything it needs."""
    from watchtower.database import CloudflareCredential, OrgNode, Project
    from watchtower.api import util

    proj = db_session.query(Project).filter(Project.id == uuid.UUID(project_id)).first()
    node = OrgNode(
        org_id=proj.org_id, name="primary", host="203.0.113.10", user="deploy",
        port=22, remote_path="/srv/app", reload_command="true",
        status="healthy", is_primary=True, is_active=True,
    )
    db_session.add(node)
    cred = CloudflareCredential(
        org_id=proj.org_id, label="main",
        api_token_encrypted=util.encrypt_secret("cf-token-plaintext"),
    )
    db_session.add(cred)
    db_session.commit()
    db_session.refresh(cred)
    return proj, cred


# ── Gates ─────────────────────────────────────────────────────────────────────

def test_go_live_requires_auth(anon_client: TestClient):
    r = anon_client.post(f"/api/projects/{uuid.uuid4()}/go-live", json={"hostname": "a.example.com"})
    assert r.status_code == 401


def test_go_live_404_for_unknown_project(client: TestClient):
    r = client.post(f"/api/projects/{uuid.uuid4()}/go-live", json={"hostname": "a.example.com"})
    assert r.status_code == 404


# ── DNS happy path ──────────────────────────────────────────────────────────

def test_go_live_dns_mode_runs_all_steps(client: TestClient, db_session, monkeypatch):
    p = _create_project(client, "golive-dns")
    _proj, cred = _seed_node_and_cred(db_session, p["id"])

    monkeypatch.setattr("watchtower.api.deployments.enqueue_build", lambda *a, **k: None)
    fake = SimpleNamespace(
        record_id="rec123", zone_id="zone123", zone_name="example.com", target_ip="203.0.113.10",
    )
    with patch("watchtower.cloudflare_dns.sync_a_record", return_value=fake) as sync:
        r = client.post(
            f"/api/projects/{p['id']}/go-live",
            json={
                "hostname": "app.example.com",
                "public_mode": "dns",
                "cloudflare_credential_id": str(cred.id),
                "proxied": True,
                "enable_autonomous": True,
            },
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["overall"] == "live"
    assert body["live_url"] == "https://app.example.com"
    steps = {s["step"]: s for s in body["steps"]}
    assert set(steps) == {"container", "deploy", "domain", "public", "autonomous"}
    assert steps["public"]["status"] == "ok"
    assert steps["container"]["status"] in {"ok", "skipped"}
    assert steps["autonomous"]["status"] in {"ok", "skipped"}
    sync.assert_called_once()
    # target_ip passed through is the node's host.
    assert sync.call_args.args[2] == "203.0.113.10"

    # Side effects persisted.
    from watchtower.database import Project
    proj = db_session.query(Project).filter(Project.id == uuid.UUID(p["id"])).first()
    db_session.refresh(proj)
    assert proj.run_as_container is True
    assert proj.autonomous_mode is True
    assert proj.live_url == "https://app.example.com"


def test_go_live_dns_mode_fails_public_without_node(client: TestClient, db_session, monkeypatch):
    """No node with a host → the public step fails, but the run still
    reports the full picture (not a hard 500)."""
    p = _create_project(client, "golive-nonode")
    # Seed only a credential, no node.
    from watchtower.database import CloudflareCredential, Project
    from watchtower.api import util
    proj = db_session.query(Project).filter(Project.id == uuid.UUID(p["id"])).first()
    cred = CloudflareCredential(
        org_id=proj.org_id, label="main",
        api_token_encrypted=util.encrypt_secret("tok"),
    )
    db_session.add(cred)
    db_session.commit()
    db_session.refresh(cred)

    monkeypatch.setattr("watchtower.api.deployments.enqueue_build", lambda *a, **k: None)
    r = client.post(
        f"/api/projects/{p['id']}/go-live",
        json={"hostname": "x.example.com", "public_mode": "dns",
              "cloudflare_credential_id": str(cred.id)},
    )
    assert r.status_code == 200, r.text
    steps = {s["step"]: s for s in r.json()["steps"]}
    assert steps["public"]["status"] == "failed"
    assert r.json()["overall"] == "failed"


# ── Tunnel mode ───────────────────────────────────────────────────────────────

def test_go_live_tunnel_falls_back_to_manual_without_credential(client: TestClient, db_session, monkeypatch):
    """Tunnel mode with no Cloudflare credential can't run the API calls, so
    it degrades to guided manual steps rather than failing the whole run."""
    p = _create_project(client, "golive-tunnel-nocred")
    monkeypatch.setattr("watchtower.api.deployments.enqueue_build", lambda *a, **k: None)

    r = client.post(
        f"/api/projects/{p['id']}/go-live",
        json={"hostname": "t.example.com", "public_mode": "tunnel", "enable_autonomous": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    steps = {s["step"]: s for s in body["steps"]}
    assert steps["public"]["status"] == "manual"
    assert steps["public"]["instructions"]
    assert any("cloudflared" in line for line in steps["public"]["instructions"])
    assert body["overall"] == "manual"
    assert steps["autonomous"]["status"] in {"ok", "skipped"}


def test_go_live_tunnel_mode_automates_when_ready(client: TestClient, db_session, monkeypatch):
    """With a credential (account_id) + a node, tunnel mode creates the
    tunnel, routes the CNAME, installs the connector, and reports 'ok'."""
    from types import SimpleNamespace

    p = _create_project(client, "golive-tunnel-ok")
    _proj, cred = _seed_node_and_cred(db_session, p["id"])
    # Ensure the credential has an account_id (required for tunnel API).
    from watchtower.database import CloudflareCredential
    cred_row = db_session.query(CloudflareCredential).filter(CloudflareCredential.id == cred.id).first()
    cred_row.account_id = "acct-123"
    db_session.commit()

    monkeypatch.setattr("watchtower.api.deployments.enqueue_build", lambda *a, **k: None)
    monkeypatch.setattr(
        "watchtower.cloudflare_dns.create_tunnel",
        lambda *a, **k: SimpleNamespace(tunnel_id="tun-1", token="connector-token", name="wt-golive-tunnel-ok"),
    )
    monkeypatch.setattr("watchtower.cloudflare_dns.configure_tunnel_ingress", lambda *a, **k: None)
    monkeypatch.setattr(
        "watchtower.cloudflare_dns.sync_cname",
        lambda *a, **k: SimpleNamespace(record_id="rec-1", zone_id="zone-1", zone_name="example.com", target_ip="tun-1.cfargotunnel.com"),
    )

    async def _fake_install(node, token, append, prefix=""):
        append("installing… (token elided)")
        return True, ""
    monkeypatch.setattr(
        "watchtower.builder.install_cloudflared_tunnel_on_node", _fake_install
    )

    r = client.post(
        f"/api/projects/{p['id']}/go-live",
        json={"hostname": "t.example.com", "public_mode": "tunnel",
              "cloudflare_credential_id": str(cred.id), "enable_autonomous": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    steps = {s["step"]: s for s in body["steps"]}
    assert steps["public"]["status"] == "ok", steps["public"]
    assert body["overall"] == "live"
