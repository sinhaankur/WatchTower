"""Phase 2 of autonomous global-deploy: nginx host-side reverse proxy.

Verifies the contract of ``_build_nginx_proxy_config`` (the config
string) and ``_apply_nginx_proxy_on_node`` (the SSH command shape and
its failure modes). _ssh_run is mocked so no real ssh/nginx is invoked.
"""

from __future__ import annotations

import asyncio
import base64
import uuid
from unittest.mock import patch
import pytest

from watchtower import builder
from watchtower.builder import (
    _apply_nginx_proxy_on_node,
    _build_nginx_proxy_config,
)
from watchtower.database import (
    CustomDomain,
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
    o = Organization(id=uuid.uuid4(), name="nginx-test-org")
    db.add(o)
    db.commit()
    db.refresh(o)
    return o


@pytest.fixture()
def project(db, org):
    p = Project(
        id=uuid.uuid4(),
        name="nginx-target",
        use_case=UseCaseType.NETLIFY_LIKE,
        repo_url="https://github.com/example/site",
        repo_branch="main",
        webhook_secret="secret",
        org_id=org.id,
        recommended_port=8082,
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
        name="proxy-node",
        host="1.2.3.4",
        user="deploy",
        port=22,
        remote_path="/srv/sites/nginx-target",
    )
    db.add(n)
    db.commit()
    db.refresh(n)
    return n


# ---------------------------------------------------------------------------
# _build_nginx_proxy_config
# ---------------------------------------------------------------------------


def test_config_shape_for_single_domain(project):
    cfg = _build_nginx_proxy_config(project, ["site.example.com"], 8082)
    assert "listen 80;" in cfg
    assert "server_name site.example.com;" in cfg
    assert "proxy_pass http://127.0.0.1:8082;" in cfg
    # Proxy headers required for the downstream container to know who
    # the real client is — drop X-Forwarded-Proto and IPv4 stops
    # working behind Cloudflare in Phase 3.
    assert "proxy_set_header Host $host;" in cfg
    assert "proxy_set_header X-Real-IP $remote_addr;" in cfg
    assert "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;" in cfg
    assert "proxy_set_header X-Forwarded-Proto $scheme;" in cfg
    # Single managed file — should always carry the marker so a human
    # opening the config knows not to edit by hand.
    assert "Managed by WatchTower" in cfg


def test_config_collapses_multiple_domains_into_one_server_name(project):
    cfg = _build_nginx_proxy_config(
        project,
        ["a.example.com", "b.example.com", "c.example.com"],
        8082,
    )
    # All three hostnames share one server block — keeps nginx config
    # surface tight and reloads in one pass regardless of how many
    # custom domains exist.
    assert "server_name a.example.com b.example.com c.example.com;" in cfg
    assert cfg.count("server {") == 1


# ---------------------------------------------------------------------------
# _apply_nginx_proxy_on_node — hostname validation
# ---------------------------------------------------------------------------


def test_apply_rejects_invalid_hostname(project, node):
    """Anything that isn't a clean FQDN is rejected before any ssh runs —
    blocks shell-injection via the domain field even though the field
    only accepts hostnames from authenticated org admins."""
    captured: list[str] = []
    with patch.object(builder, "_ssh_run") as mock_ssh:
        ok, err = asyncio.run(
            _apply_nginx_proxy_on_node(
                node, project, ["evil.com; rm -rf /"], captured.append
            )
        )
    assert ok is False
    assert "invalid hostname" in err
    # No ssh commands should have been issued — fail at the validation
    # gate, before anything reaches the node.
    mock_ssh.assert_not_called()


def test_apply_rejects_when_recommended_port_missing(project, node, db):
    project.recommended_port = None
    db.commit()
    db.refresh(project)
    with patch.object(builder, "_ssh_run") as mock_ssh:
        ok, err = asyncio.run(
            _apply_nginx_proxy_on_node(node, project, ["site.example.com"], lambda _l: None)
        )
    assert ok is False
    assert "recommended_port" in err
    mock_ssh.assert_not_called()


# ---------------------------------------------------------------------------
# _apply_nginx_proxy_on_node — happy + failure paths
# ---------------------------------------------------------------------------


def test_apply_happy_path_writes_config_validates_reloads(project, node):
    """Confirms the 3-step command sequence: write+symlink → nginx -t → reload."""
    commands: list[str] = []

    async def fake_ssh(_n, command, _append, prefix=""):
        commands.append(command)
        return True, ""

    with patch.object(builder, "_ssh_run", side_effect=fake_ssh):
        ok, err = asyncio.run(
            _apply_nginx_proxy_on_node(
                node, project, ["site.example.com"], lambda _l: None
            )
        )

    assert ok is True
    assert err == ""
    assert len(commands) == 3

    # 1. Config write — base64-decoded then piped via sudo tee to
    #    sites-available, then ln -sf into sites-enabled. Decoding the
    #    base64 chunk lets us assert what the config string actually
    #    contained.
    write_cmd = commands[0]
    assert "sudo tee" in write_cmd
    assert "/etc/nginx/sites-available/" in write_cmd
    assert "sudo ln -sf" in write_cmd
    assert "/etc/nginx/sites-enabled/" in write_cmd
    # Extract the base64 chunk and decode it back to the config body.
    # ``shlex.quote`` only adds quotes when the string contains shell
    # metacharacters — a bare base64 token doesn't, so we accept either
    # ``echo TOKEN |`` or ``echo 'TOKEN' |``.
    import re
    m = re.search(r"echo '?([A-Za-z0-9+/=]+)'? \| base64", write_cmd)
    assert m, write_cmd
    config = base64.b64decode(m.group(1)).decode("utf-8")
    assert "proxy_pass http://127.0.0.1:8082;" in config
    assert "server_name site.example.com;" in config

    # 2. Validation
    assert commands[1] == "sudo nginx -t"

    # 3. Reload — using systemctl, not raw `nginx -s reload`, so the
    #    operator's service-manager state stays consistent.
    assert commands[2] == "sudo systemctl reload nginx"


def test_apply_rolls_back_symlink_when_nginx_test_fails(project, node):
    """If nginx -t rejects the config, the deploy must NOT proceed to
    reload (would 502 every existing site on that nginx). Verify we
    yank the symlink so a future operator-initiated reload doesn't pick
    up the rejected config."""
    cmds: list[str] = []

    async def fake_ssh(_n, command, _append, prefix=""):
        cmds.append(command)
        if command == "sudo nginx -t":
            return False, "nginx: [emerg] invalid number of arguments"
        return True, ""

    with patch.object(builder, "_ssh_run", side_effect=fake_ssh):
        ok, err = asyncio.run(
            _apply_nginx_proxy_on_node(
                node, project, ["site.example.com"], lambda _l: None
            )
        )

    assert ok is False
    assert "nginx -t" in err
    # The 3 commands we expect: write, validate, rollback. Reload must
    # never run.
    assert any("sudo nginx -t" in c for c in cmds)
    assert any(c.startswith("sudo rm -f") and "sites-enabled" in c for c in cmds), (
        f"Expected symlink rollback after failed nginx -t, got: {cmds}"
    )
    assert not any("systemctl reload" in c for c in cmds), (
        "Reload must not run after failed validation"
    )


def test_apply_surfaces_reload_failure_as_deploy_failure(project, node):
    """Validation passes but the reload itself fails (e.g. systemctl
    permission issue). Phase 2 treats this as fatal because the site
    isn't actually reachable on the configured hostname."""
    async def fake_ssh(_n, command, _append, prefix=""):
        if "systemctl reload" in command:
            return False, "Failed to reload nginx.service: Access denied"
        return True, ""

    with patch.object(builder, "_ssh_run", side_effect=fake_ssh):
        ok, err = asyncio.run(
            _apply_nginx_proxy_on_node(
                node, project, ["site.example.com"], lambda _l: None
            )
        )

    assert ok is False
    assert "reload failed" in err


# ---------------------------------------------------------------------------
# _deploy_to_one_node — Phase 2 layered on Phase 1
# ---------------------------------------------------------------------------


def test_deploy_to_one_node_skips_nginx_when_no_domains(project, node):
    """No CustomDomain rows → container deploys but nginx step skipped.
    Keeps the iteration loop fast for users who haven't picked a
    hostname yet."""
    cmds: list[str] = []

    async def fake_rsync(*_a, **_kw):
        return True, ""

    async def fake_ssh(_n, command, _append, prefix=""):
        cmds.append(command)
        return True, ""

    with patch.object(builder, "_rsync_to_node", side_effect=fake_rsync), \
         patch.object(builder, "_ssh_run", side_effect=fake_ssh):
        ok, err = asyncio.run(
            builder._deploy_to_one_node(
                node, project, builder.Path("/tmp/out"), [], lambda _l: None
            )
        )

    assert ok is True
    assert err == ""
    # No Phase 2 commands should have been issued. (Phase 1's podman
    # run contains "nginx:alpine" as the IMAGE name, so we can't just
    # grep for "nginx" — instead we check the Phase-2-specific shapes.)
    assert not any("sudo nginx -t" in c for c in cmds)
    assert not any("sites-available" in c for c in cmds)
    assert not any("systemctl reload nginx" in c for c in cmds)


def test_deploy_to_one_node_runs_nginx_when_domains_present(project, node):
    """With CustomDomain rows, the deploy must reach the nginx step
    after the container is healthy."""
    cmds: list[str] = []

    async def fake_rsync(*_a, **_kw):
        return True, ""

    async def fake_ssh(_n, command, _append, prefix=""):
        cmds.append(command)
        return True, ""

    with patch.object(builder, "_rsync_to_node", side_effect=fake_rsync), \
         patch.object(builder, "_ssh_run", side_effect=fake_ssh):
        ok, err = asyncio.run(
            builder._deploy_to_one_node(
                node, project, builder.Path("/tmp/out"),
                ["site.example.com"], lambda _l: None
            )
        )

    assert ok is True
    assert any("sites-available" in c for c in cmds)
    assert any("sudo nginx -t" in c for c in cmds)
    assert any("systemctl reload nginx" in c for c in cmds)
