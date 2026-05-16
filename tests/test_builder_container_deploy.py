"""Phase 1 of autonomous global-deploy: containerized remote deploys.

These tests pin the contract of the new ``_run_static_container_on_node``
helper and the ``project.run_as_container`` branch inside
``_deploy_to_one_node``. They mock out ``_ssh_run`` / ``_rsync_to_node``
so no real podman or ssh process is spawned — the goal is to verify the
*command shape* we send and the failure-mode handling, not Podman itself.
"""

from __future__ import annotations

import asyncio
import uuid
from unittest.mock import AsyncMock, patch
import pytest

from watchtower import builder
from watchtower.builder import _container_name, _run_static_container_on_node
from watchtower.database import (
    Organization,
    OrgNode,
    Project,
    SessionLocal,
    UseCaseType,
)


@pytest.fixture()
def db():
    s = SessionLocal()
    yield s
    s.close()


@pytest.fixture()
def org(db):
    o = Organization(id=uuid.uuid4(), name="container-test-org")
    db.add(o)
    db.commit()
    db.refresh(o)
    return o


@pytest.fixture()
def project(db, org):
    p = Project(
        id=uuid.uuid4(),
        name="container-app",
        use_case=UseCaseType.NETLIFY_LIKE,
        repo_url="https://github.com/example/static-site",
        repo_branch="main",
        webhook_secret="secret",
        org_id=org.id,
        recommended_port=8081,
        run_as_container=True,
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@pytest.fixture()
def node(db, org):
    n = OrgNode(
        id=uuid.uuid4(),
        org_id=org.id,
        name="prod-1",
        host="prod-1.example.com",
        user="deploy",
        port=22,
        remote_path="/srv/sites/container-app",
        # reload_command is intentionally set so we can verify the
        # container path IGNORES it (would be a regression to also run
        # nginx -s reload alongside the container).
        reload_command="sudo systemctl reload nginx",
    )
    db.add(n)
    db.commit()
    db.refresh(n)
    return n


# ---------------------------------------------------------------------------
# _container_name
# ---------------------------------------------------------------------------


def test_container_name_is_deterministic_and_namespaced(project):
    name = _container_name(project)
    assert name.startswith("wt-")
    # Same project → same name (so a redeploy can stop+rm the old one).
    assert _container_name(project) == name
    # Should be safe for podman's name charset — lowercase + hex only.
    suffix = name[len("wt-"):]
    assert suffix == suffix.lower()
    assert all(c in "0123456789abcdef" for c in suffix)


# ---------------------------------------------------------------------------
# _run_static_container_on_node — error paths
# ---------------------------------------------------------------------------


def test_run_static_container_rejects_project_without_port(project, node, db):
    project.recommended_port = None
    db.commit()
    db.refresh(project)

    captured: list[str] = []
    ok, err = asyncio.run(_run_static_container_on_node(node, project, captured.append))

    assert ok is False
    assert "recommended_port" in err
    # Operator-facing message — must name the field so they know what to set.
    assert any("recommended_port" in line for line in captured)


def test_run_static_container_surfaces_probe_failure(project, node):
    # Mock _ssh_run so podman run "succeeds" but the health probe fails.
    # Sequence we expect: (1) podman run command → ok; (2) probe → fail.
    calls: list[str] = []

    async def fake_ssh_run(_node, command, append, prefix=""):
        calls.append(command)
        if command.startswith("podman run") or "podman rm" in command:
            return True, ""
        # Anything else is the probe — fail it.
        return False, "curl: (7) Failed to connect"

    captured: list[str] = []
    with patch.object(builder, "_ssh_run", side_effect=fake_ssh_run):
        ok, err = asyncio.run(_run_static_container_on_node(node, project, captured.append))

    assert ok is False
    assert "health probe" in err
    # The error message should point the operator at `podman logs <name>`
    # so they can debug a misconfigured artifact.
    assert "podman logs" in err
    assert any("podman run" in c for c in calls), "podman run command never issued"


# ---------------------------------------------------------------------------
# _run_static_container_on_node — happy path command shape
# ---------------------------------------------------------------------------


def test_run_static_container_emits_expected_podman_run_command(project, node):
    # Capture every command issued via _ssh_run. The happy path is:
    # (1) podman rm + podman run; (2) curl probe loop → exits 0.
    captured_cmds: list[str] = []

    async def fake_ssh_run(_node, command, append, prefix=""):
        captured_cmds.append(command)
        return True, ""

    with patch.object(builder, "_ssh_run", side_effect=fake_ssh_run):
        ok, err = asyncio.run(_run_static_container_on_node(node, project, lambda _l: None))

    assert ok is True
    assert err == ""
    # We expect exactly two _ssh_run invocations: run command + probe.
    assert len(captured_cmds) == 2
    run_cmd, probe_cmd = captured_cmds

    # Container name uses our project-derived slug.
    expected_name = _container_name(project)
    assert expected_name in run_cmd
    # Host port comes from project.recommended_port → container :80.
    assert f"-p {project.recommended_port}:80" in run_cmd
    # Bind mount maps node.remote_path → nginx html root, read-only with
    # SELinux relabel.
    assert f"{node.remote_path}:/usr/share/nginx/html:ro,z" in run_cmd
    # Restart policy for daemon-restart resilience (full reboot survival
    # is a Phase-4 concern).
    assert "--restart=always" in run_cmd
    # Default static image — overridable via env var.
    assert "nginx:alpine" in run_cmd
    # Probe loop hits the bound port on localhost (curl from the node
    # itself, not from the WatchTower host).
    assert f"http://127.0.0.1:{project.recommended_port}/" in probe_cmd
    assert "curl" in probe_cmd


# ---------------------------------------------------------------------------
# _deploy_to_one_node — branching on project.run_as_container
# ---------------------------------------------------------------------------


def test_deploy_to_one_node_legacy_path_does_not_invoke_podman(project, node, db):
    """When run_as_container=False the deploy must follow the legacy
    rsync→reload_command path with zero podman commands. Regression guard
    against an accidental "always containerize" rollout."""
    project.run_as_container = False
    db.commit()
    db.refresh(project)

    ssh_cmds: list[str] = []

    async def fake_rsync(_n, _src, _append, prefix=""):
        return True, ""

    async def fake_ssh(_n, command, _append, prefix=""):
        ssh_cmds.append(command)
        return True, ""

    with patch.object(builder, "_rsync_to_node", side_effect=fake_rsync), \
         patch.object(builder, "_ssh_run", side_effect=fake_ssh):
        ok, err = asyncio.run(
            builder._deploy_to_one_node(node, project, builder.Path("/tmp/out"), lambda _l: None)
        )

    assert ok is True
    assert err == ""
    # The only command sent should be the user's reload_command — not
    # podman stop / podman run / curl probe.
    assert ssh_cmds == [node.reload_command]
    assert not any("podman" in c for c in ssh_cmds)


def test_deploy_to_one_node_container_path_stops_before_rsync(project, node):
    """The bind-mounted directory must not be held open during
    ``rsync --delete``. Verify the order: podman stop → rsync → run."""
    timeline: list[str] = []

    async def fake_rsync(_n, _src, _append, prefix=""):
        timeline.append("rsync")
        return True, ""

    async def fake_ssh(_n, command, _append, prefix=""):
        if command.startswith("podman stop"):
            timeline.append("stop")
        elif "podman run" in command:
            timeline.append("run")
        elif "curl" in command:
            timeline.append("probe")
        return True, ""

    with patch.object(builder, "_rsync_to_node", side_effect=fake_rsync), \
         patch.object(builder, "_ssh_run", side_effect=fake_ssh):
        ok, _err = asyncio.run(
            builder._deploy_to_one_node(node, project, builder.Path("/tmp/out"), lambda _l: None)
        )

    assert ok is True
    # Critical ordering: container stopped BEFORE rsync, started AFTER.
    assert timeline == ["stop", "rsync", "run", "probe"]


def test_deploy_to_one_node_container_path_ignores_reload_command(project, node):
    """When run_as_container=True the legacy reload_command must NOT also
    run — otherwise an existing nginx reload could conflict with the new
    container picking up the port. The reload_command stays on the node
    in case the user toggles back, but the container path owns the lifecycle."""
    ssh_cmds: list[str] = []

    async def fake_rsync(*_a, **_kw):
        return True, ""

    async def fake_ssh(_n, command, _append, prefix=""):
        ssh_cmds.append(command)
        return True, ""

    with patch.object(builder, "_rsync_to_node", side_effect=fake_rsync), \
         patch.object(builder, "_ssh_run", side_effect=fake_ssh):
        asyncio.run(
            builder._deploy_to_one_node(node, project, builder.Path("/tmp/out"), lambda _l: None)
        )

    assert not any(node.reload_command in c for c in ssh_cmds), (
        f"reload_command leaked into container deploy: {ssh_cmds}"
    )
