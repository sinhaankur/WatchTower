"""Phase 4 of autonomous global-deploy: post-LIVE health probe + restart
+ rollback engine.

These tests pin the *behavior* of one tick — given a project, a node,
and a probe outcome, what does the engine do? The SSH probe and the
build queue are mocked so the tests run without touching a real node
or a real RQ worker.
"""
from __future__ import annotations

import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from watchtower import autonomous, builder
from watchtower.database import (
    Deployment,
    DeploymentNode,
    DeploymentStatus,
    DeploymentTrigger,
    Organization,
    OrgNode,
    Project,
    SessionLocal,
    UseCaseType,
)


@pytest.fixture(autouse=True)
def _reset_state():
    autonomous.reset_state()
    yield
    autonomous.reset_state()


@pytest.fixture()
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture()
def org(db):
    o = Organization(id=uuid.uuid4(), name="autonomous-test-org")
    db.add(o); db.commit(); db.refresh(o)
    return o


@pytest.fixture()
def project(db, org):
    p = Project(
        id=uuid.uuid4(),
        name="auto-target",
        use_case=UseCaseType.NETLIFY_LIKE,
        repo_url="https://github.com/example/site",
        repo_branch="main",
        webhook_secret="secret",
        org_id=org.id,
        recommended_port=8081,
        run_as_container=True,
        autonomous_mode=True,
        is_active=True,
    )
    db.add(p); db.commit(); db.refresh(p)
    return p


@pytest.fixture()
def node(db, org):
    n = OrgNode(
        id=uuid.uuid4(),
        org_id=org.id,
        name="prod",
        host="1.2.3.4",
        user="deploy",
        port=22,
        remote_path="/srv/auto-target",
        is_primary=True,
    )
    db.add(n); db.commit(); db.refresh(n)
    return n


def _make_live_deployment(db, project, node, *, created_at=None):
    """Create one LIVE deployment with one DeploymentNode entry pinned
    to *node*. The autonomous tick needs both rows to figure out which
    node to probe."""
    d = Deployment(
        id=uuid.uuid4(),
        project_id=project.id,
        commit_sha="abc1234",
        branch="main",
        status=DeploymentStatus.LIVE,
        trigger=DeploymentTrigger.MANUAL,
    )
    if created_at:
        d.created_at = created_at
    db.add(d)
    db.flush()
    db.add(DeploymentNode(
        deployment_id=d.id,
        node_id=node.id,
        status=DeploymentStatus.LIVE,
    ))
    db.commit()
    db.refresh(d)
    return d


# ── _pick_target_node ───────────────────────────────────────────────────────


def test_pick_target_prefers_is_primary(org):
    a = OrgNode(id=uuid.uuid4(), org_id=org.id, name="a", host="1.1.1.1", is_primary=False)
    b = OrgNode(id=uuid.uuid4(), org_id=org.id, name="b", host="2.2.2.2", is_primary=True)
    assert autonomous._pick_target_node([a, b]) is b


def test_pick_target_falls_back_to_first(org):
    a = OrgNode(id=uuid.uuid4(), org_id=org.id, name="a", host="1.1.1.1")
    b = OrgNode(id=uuid.uuid4(), org_id=org.id, name="b", host="2.2.2.2")
    assert autonomous._pick_target_node([a, b]) is a


# ── Failure ladder ──────────────────────────────────────────────────────────


def test_first_failure_logs_but_does_not_restart(db, project, node):
    """1 fail → tolerate. No restart, no rollback."""
    _make_live_deployment(db, project, node)

    async def probe_fails(*_a, **_kw):
        return False

    with patch.object(autonomous, "_probe_container", side_effect=probe_fails), \
         patch.object(autonomous, "_restart_container", new_callable=AsyncMock) as mock_restart, \
         patch.object(autonomous, "_enqueue_auto_rollback") as mock_rollback:
        asyncio.run(autonomous._evaluate_project(db, project))

    mock_restart.assert_not_called()
    mock_rollback.assert_not_called()
    # Counter advanced to 1.
    state = autonomous.snapshot_state()
    assert len(state) == 1
    assert state[0]["consecutive_failures"] == 1


def test_second_failure_restarts_container(db, project, node):
    """2 fails → podman restart. Still no rollback."""
    _make_live_deployment(db, project, node)

    async def probe_fails(*_a, **_kw):
        return False
    async def restart_ok(*_a, **_kw):
        return True, ""

    with patch.object(autonomous, "_probe_container", side_effect=probe_fails), \
         patch.object(autonomous, "_restart_container", side_effect=restart_ok) as mock_restart, \
         patch.object(autonomous, "_enqueue_auto_rollback") as mock_rollback:
        # Tick 1: fail #1
        asyncio.run(autonomous._evaluate_project(db, project))
        # Tick 2: fail #2 → restart
        asyncio.run(autonomous._evaluate_project(db, project))

    mock_restart.assert_called_once()
    mock_rollback.assert_not_called()
    assert autonomous.snapshot_state()[0]["consecutive_failures"] == 2


def test_third_failure_triggers_rollback_and_quarantine(db, project, node):
    """3 fails → auto-rollback + quarantine. Counter resets to 0
    (we acted), quarantine prevents re-action for the cooldown."""
    # Two LIVE deployments — rollback needs a target.
    from datetime import datetime, timedelta
    older = _make_live_deployment(db, project, node, created_at=datetime.utcnow() - timedelta(hours=1))
    _make_live_deployment(db, project, node)
    assert older is not None

    async def probe_fails(*_a, **_kw):
        return False
    async def restart_ok(*_a, **_kw):
        return True, ""

    with patch.object(autonomous, "_probe_container", side_effect=probe_fails), \
         patch.object(autonomous, "_restart_container", side_effect=restart_ok), \
         patch.object(autonomous, "_enqueue_auto_rollback", return_value=uuid.uuid4()) as mock_rollback:
        for _ in range(3):
            asyncio.run(autonomous._evaluate_project(db, project))

    mock_rollback.assert_called_once()
    snap = autonomous.snapshot_state()[0]
    assert snap["quarantined"] is True
    assert snap["consecutive_failures"] == 0  # reset after acting


def test_success_resets_counter(db, project, node):
    """A single success after fails wipes the slate clean — flaky
    deploys shouldn't drift to rollback on their second hiccup an
    hour later."""
    _make_live_deployment(db, project, node)

    outcomes = iter([False, True])  # tick 1 fails, tick 2 succeeds
    async def probe(*_a, **_kw):
        return next(outcomes)

    with patch.object(autonomous, "_probe_container", side_effect=probe), \
         patch.object(autonomous, "_restart_container", new_callable=AsyncMock):
        asyncio.run(autonomous._evaluate_project(db, project))
        assert autonomous.snapshot_state()[0]["consecutive_failures"] == 1
        asyncio.run(autonomous._evaluate_project(db, project))
        assert autonomous.snapshot_state()[0]["consecutive_failures"] == 0


def test_quarantine_skips_evaluation(db, project, node):
    """Once quarantined, ticks short-circuit — the rollback build is
    in flight and another probe would just re-fail and pointlessly
    re-trigger the ladder."""
    _make_live_deployment(db, project, node)
    state = autonomous._state_for(project.id, node.id)
    import time as _time
    state.quarantined_until = _time.time() + 3600  # 1h cooldown

    probe_mock = AsyncMock()
    with patch.object(autonomous, "_probe_container", probe_mock):
        asyncio.run(autonomous._evaluate_project(db, project))

    probe_mock.assert_not_called()


# ── Tick-level opt-in gating ────────────────────────────────────────────────


def test_tick_skips_project_without_run_as_container(db, project, node):
    """Phase 4 requires Phase 1. A project flipped to autonomous_mode=True
    without run_as_container should be a no-op at the tick level — same
    safety the API enforces at the toggle level."""
    project.run_as_container = False
    db.commit()
    probe_mock = AsyncMock()
    with patch.object(autonomous, "_probe_container", probe_mock):
        evaluated = asyncio.run(autonomous.tick())
    assert evaluated == 0
    probe_mock.assert_not_called()


def test_tick_skips_when_deploy_is_in_progress(db, project, node):
    """An active deploy means the operator is already changing state —
    let it finish before the autonomous tick piles on probes."""
    d = Deployment(
        id=uuid.uuid4(),
        project_id=project.id,
        commit_sha="x", branch="main",
        status=DeploymentStatus.DEPLOYING,  # NOT LIVE
        trigger=DeploymentTrigger.MANUAL,
    )
    db.add(d); db.commit()

    probe_mock = AsyncMock()
    with patch.object(autonomous, "_probe_container", probe_mock):
        asyncio.run(autonomous._evaluate_project(db, project))
    probe_mock.assert_not_called()


# ── Scheduler glue ──────────────────────────────────────────────────────────


def test_start_stop_scheduler_is_idempotent():
    """The lifespan hook calls start_scheduler() unconditionally; tests
    or worker processes may call stop_scheduler() multiple times. Both
    must be safe to invoke repeatedly. AsyncIOScheduler.start() requires
    a running event loop, so the body runs inside asyncio.run() — same
    as production, where the FastAPI lifespan is async."""
    async def _body():
        autonomous.stop_scheduler()  # no scheduler yet — should not raise
        autonomous.start_scheduler()
        autonomous.start_scheduler()  # second call is a no-op
        autonomous.stop_scheduler()
        autonomous.stop_scheduler()  # idempotent stop
    asyncio.run(_body())
