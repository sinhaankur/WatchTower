"""Self-heal loop + runtime LLM settings.

Covers the two halves shipped together:

  * Runtime LLM config — PUT /api/agent/config persists to system_settings
    (api key encrypted, never echoed), GET reports source precedence,
    POST /api/agent/test probes the endpoint (network monkeypatched).
  * Self-heal — the tick turns FAILED deployments into HealingActions:
    auto-applies safe fixes when the autonomy switch is ON, queues for
    human approval otherwise; approve/dismiss endpoints resolve them.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

from watchtower import self_heal
from watchtower.database import (
    Build,
    BuildStatus,
    Deployment,
    DeploymentStatus,
    DeploymentTrigger,
    HealingAction,
    HealingActionStatus,
    Project,
    SystemSetting,
    UseCaseType,
)
from watchtower.api import util as _util


PORT_IN_USE_LOG = "Error: listen EADDRINUSE: address already in use 0.0.0.0:3000\n"
UNKNOWN_LOG = "some opaque stack trace nobody has regexes for\n"


@pytest.fixture()
def canonical_user_id(db_session):
    # The static-token synthetic user id, same shape get_current_user derives.
    return _util.canonical_user_id(
        db_session,
        {
            "user_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "watchtower:test-token")),
            "email": "developer@watchtower.local",
        },
    )


def _seed_failed_deployment(db, owner_id, *, log=PORT_IN_USE_LOG, name=None):
    project = Project(
        id=uuid.uuid4(),
        name=name or f"heal-{uuid.uuid4().hex[:6]}",
        use_case=UseCaseType.NETLIFY_LIKE,
        repo_url="https://github.com/example/site",
        repo_branch="main",
        webhook_secret="secret",
        org_id=uuid.uuid4(),
        owner_id=owner_id,
        recommended_port=3000,
        is_active=True,
    )
    db.add(project)
    deployment = Deployment(
        id=uuid.uuid4(),
        project_id=project.id,
        commit_sha="abc123",
        branch="main",
        status=DeploymentStatus.FAILED,
        trigger=DeploymentTrigger.MANUAL,
    )
    db.add(deployment)
    db.flush()
    db.add(Build(
        id=uuid.uuid4(),
        deployment_id=deployment.id,
        status=BuildStatus.FAILED,
        build_output=log,
    ))
    db.commit()
    return project, deployment


@pytest.fixture(autouse=True)
def _no_real_builds(monkeypatch):
    """The tick and approve endpoints enqueue builds — keep them virtual."""
    monkeypatch.setattr("watchtower.queue.enqueue_build", lambda *a, **k: "test-noop")
    monkeypatch.setattr("watchtower.api.healing.enqueue_build", lambda *a, **k: "test-noop")


# ── LLM runtime config ───────────────────────────────────────────────────────


def test_agent_config_roundtrip_and_secret_never_echoed(client, db_session):
    r = client.put("/api/agent/config", json={
        "base_url": "http://localhost:1234/v1",
        "api_key": "lm-studio-key",
        "model": "qwen2.5-coder-7b",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["configured"] is True
    assert body["base_url"] == "http://localhost:1234/v1"
    assert body["model"] == "qwen2.5-coder-7b"
    assert body["source"] == "database"
    assert body["has_api_key"] is True
    assert "lm-studio-key" not in r.text

    r = client.get("/api/agent/config")
    assert r.status_code == 200
    assert "lm-studio-key" not in r.text
    assert r.json()["has_api_key"] is True

    # Stored encrypted, not plaintext.
    row = db_session.query(SystemSetting).filter(SystemSetting.key == "llm.api_key").first()
    assert row is not None and row.is_secret is True
    assert "lm-studio-key" not in (row.value or "")


def test_agent_config_rejects_bad_scheme(client):
    r = client.put("/api/agent/config", json={"base_url": "ftp://example.com/v1"})
    assert r.status_code == 400


def test_agent_config_clear_falls_back_to_env(client, monkeypatch):
    monkeypatch.setenv("WATCHTOWER_LLM_BASE_URL", "http://envhost:11434/v1")
    client.put("/api/agent/config", json={"base_url": "http://localhost:1234/v1"})
    r = client.put("/api/agent/config", json={"base_url": ""})
    assert r.status_code == 200
    body = r.json()
    assert body["base_url"] == "http://envhost:11434/v1"
    assert body["source"] == "env"


def test_agent_test_connection_lists_models(client, monkeypatch):
    monkeypatch.setattr(
        "watchtower.api.agent._list_models",
        lambda base_url, api_key: ["qwen2.5-coder-7b", "llama-3.2-3b"],
    )
    r = client.post("/api/agent/test", json={"base_url": "http://localhost:1234/v1"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "qwen2.5-coder-7b" in body["models"]


def test_agent_test_connection_reports_failure(client, monkeypatch):
    def _boom(base_url, api_key):
        raise ConnectionError("connection refused")
    monkeypatch.setattr("watchtower.api.agent._list_models", _boom)
    r = client.post("/api/agent/test", json={"base_url": "http://localhost:9999/v1"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "connection refused" in body["error"]


# ── Autonomy switch ──────────────────────────────────────────────────────────


def test_autonomy_switch_defaults_off_and_toggles(client):
    r = client.get("/api/healing/config")
    assert r.status_code == 200
    assert r.json()["autonomous_enabled"] is False

    r = client.put("/api/healing/config", json={"autonomous_enabled": True})
    assert r.status_code == 200
    assert r.json()["autonomous_enabled"] is True

    assert client.get("/api/healing/config").json()["autonomous_enabled"] is True


# ── The tick ─────────────────────────────────────────────────────────────────


def test_tick_queues_for_human_when_autonomy_off(client, db_session, canonical_user_id):
    _project, deployment = _seed_failed_deployment(db_session, canonical_user_id)

    processed = asyncio.run(self_heal.tick())
    assert processed == 1

    r = client.get("/api/healing/actions", params={"status_filter": "pending"})
    assert r.status_code == 200
    actions = r.json()
    assert len(actions) == 1
    a = actions[0]
    assert a["deployment_id"] == str(deployment.id)
    assert a["failure_kind"] == "port_in_use"
    assert a["auto_applicable"] is True
    assert a["status"] == "pending"

    # Second tick must not double-decide the same deployment.
    assert asyncio.run(self_heal.tick()) == 0


def test_tick_auto_applies_when_autonomy_on(client, db_session, canonical_user_id, monkeypatch):
    client.put("/api/healing/config", json={"autonomous_enabled": True})
    monkeypatch.setattr(
        "watchtower.api.runtime.pick_free_port_for_user",
        lambda db, user_id, excluded=None: 3001,
    )
    project, deployment = _seed_failed_deployment(db_session, canonical_user_id)

    assert asyncio.run(self_heal.tick()) == 1

    db_session.expire_all()
    action = db_session.query(HealingAction).filter(
        HealingAction.deployment_id == deployment.id
    ).first()
    assert action is not None
    assert action.status == HealingActionStatus.AUTO_APPLIED
    assert action.result_deployment_id is not None

    retry = db_session.query(Deployment).filter(
        Deployment.id == action.result_deployment_id
    ).first()
    assert retry is not None
    assert retry.status == DeploymentStatus.PENDING
    assert retry.commit_sha == "abc123"
    # Port actually moved off the conflicting one.
    db_session.refresh(project)
    assert project.recommended_port == 3001


def test_tick_unknown_failure_stays_pending_without_llm(client, db_session, canonical_user_id):
    client.put("/api/healing/config", json={"autonomous_enabled": True})
    _project, deployment = _seed_failed_deployment(db_session, canonical_user_id, log=UNKNOWN_LOG)

    assert asyncio.run(self_heal.tick()) == 1
    db_session.expire_all()
    action = db_session.query(HealingAction).filter(
        HealingAction.deployment_id == deployment.id
    ).first()
    assert action.status == HealingActionStatus.PENDING
    assert action.failure_kind == "unknown"
    assert action.llm_analysis is None  # no LLM configured in tests


def test_tick_attaches_llm_analysis_for_unknown_failures(client, db_session, canonical_user_id, monkeypatch):
    client.put("/api/agent/config", json={"base_url": "http://localhost:1234/v1"})
    monkeypatch.setattr(
        self_heal, "_llm_analyze_sync",
        lambda base_url, api_key, model, log: "Root cause: the flux capacitor. Fix: add plutonium.",
    )
    _project, deployment = _seed_failed_deployment(db_session, canonical_user_id, log=UNKNOWN_LOG)

    assert asyncio.run(self_heal.tick()) == 1
    db_session.expire_all()
    action = db_session.query(HealingAction).filter(
        HealingAction.deployment_id == deployment.id
    ).first()
    assert action.llm_analysis is not None
    assert "flux capacitor" in action.llm_analysis


def test_thrash_guardrail_stops_auto_fix_loop(client, db_session, canonical_user_id, monkeypatch):
    client.put("/api/healing/config", json={"autonomous_enabled": True})
    monkeypatch.setattr(
        "watchtower.api.runtime.pick_free_port_for_user",
        lambda db, user_id, excluded=None: 3001,
    )
    project, _d = _seed_failed_deployment(db_session, canonical_user_id)

    # Seed 3 recent AUTO_APPLIED rows — the guardrail's trip point.
    for _ in range(3):
        dep = Deployment(
            id=uuid.uuid4(), project_id=project.id, commit_sha="x",
            branch="main", status=DeploymentStatus.FAILED,
            trigger=DeploymentTrigger.MANUAL,
        )
        db_session.add(dep)
        db_session.flush()
        db_session.add(HealingAction(
            project_id=project.id, deployment_id=dep.id,
            failure_kind="port_in_use", auto_applicable=True,
            status=HealingActionStatus.AUTO_APPLIED,
        ))
    db_session.commit()

    assert asyncio.run(self_heal.tick()) == 1
    db_session.expire_all()
    pending = db_session.query(HealingAction).filter(
        HealingAction.project_id == project.id,
        HealingAction.status == HealingActionStatus.PENDING,
    ).all()
    assert len(pending) == 1
    assert "guardrail" in (pending[0].error or "")


# ── Human intervention: approve / dismiss ────────────────────────────────────


def test_approve_applies_fix_and_queues_retry(client, db_session, canonical_user_id, monkeypatch):
    monkeypatch.setattr(
        "watchtower.api.runtime.pick_free_port_for_user",
        lambda db, user_id, excluded=None: 3002,
    )
    _project, _deployment = _seed_failed_deployment(db_session, canonical_user_id)
    asyncio.run(self_heal.tick())

    actions = client.get("/api/healing/actions", params={"status_filter": "pending"}).json()
    action_id = actions[0]["id"]

    r = client.post(f"/api/healing/actions/{action_id}/approve")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["applied"] is True
    assert body["new_deployment_id"]

    # Resolved — approving twice conflicts.
    assert client.post(f"/api/healing/actions/{action_id}/approve").status_code == 409
    assert client.get("/api/healing/actions", params={"status_filter": "pending"}).json() == []


def test_dismiss_resolves_without_acting(client, db_session, canonical_user_id):
    _project, deployment = _seed_failed_deployment(db_session, canonical_user_id, log=UNKNOWN_LOG)
    asyncio.run(self_heal.tick())

    actions = client.get("/api/healing/actions", params={"status_filter": "pending"}).json()
    r = client.post(f"/api/healing/actions/{actions[0]['id']}/dismiss")
    assert r.status_code == 200

    db_session.expire_all()
    action = db_session.query(HealingAction).filter(
        HealingAction.deployment_id == deployment.id
    ).first()
    assert action.status == HealingActionStatus.DISMISSED
    # No retry deployment was created.
    count = db_session.query(Deployment).filter(
        Deployment.project_id == action.project_id
    ).count()
    assert count == 1


def test_actions_scoped_to_owner(client, db_session):
    """A failed deployment on someone else's project never shows up."""
    _seed_failed_deployment(db_session, uuid.uuid4())  # foreign owner
    asyncio.run(self_heal.tick())
    assert client.get("/api/healing/actions").json() == []


# ── Tiny-model switch for autonomous analysis ────────────────────────────────


def test_analysis_model_falls_back_to_main_model(client):
    client.put("/api/agent/config", json={
        "base_url": "http://localhost:8080/v1", "model": "qwen3-4b",
    })
    body = client.get("/api/agent/config").json()
    assert body["analysis_model"] == "qwen3-4b"
    assert body["has_dedicated_analysis_model"] is False


def test_dedicated_tiny_analysis_model_roundtrip_and_clear(client):
    client.put("/api/agent/config", json={
        "base_url": "http://localhost:8080/v1",
        "model": "qwen3-4b",
        "analysis_model": "smollm2-360m-instruct",
    })
    body = client.get("/api/agent/config").json()
    assert body["model"] == "qwen3-4b"
    assert body["analysis_model"] == "smollm2-360m-instruct"
    assert body["has_dedicated_analysis_model"] is True

    # Clearing reverts self-heal to the main model.
    client.put("/api/agent/config", json={"analysis_model": ""})
    body = client.get("/api/agent/config").json()
    assert body["analysis_model"] == "qwen3-4b"
    assert body["has_dedicated_analysis_model"] is False


def test_self_heal_uses_analysis_model(client, db_session, canonical_user_id, monkeypatch):
    """The autonomous loop must call the LLM with the tiny analysis model,
    not the main chat model."""
    client.put("/api/agent/config", json={
        "base_url": "http://localhost:8080/v1",
        "model": "big-chat-model",
        "analysis_model": "tiny-analysis-model",
    })
    used = {}

    def fake_analyze(base_url, api_key, model, log):
        used["model"] = model
        return "analysis"
    monkeypatch.setattr(self_heal, "_llm_analyze_sync", fake_analyze)

    _seed_failed_deployment(db_session, canonical_user_id, log=UNKNOWN_LOG)
    asyncio.run(self_heal.tick())
    assert used["model"] == "tiny-analysis-model"
