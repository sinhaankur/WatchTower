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


# ---------------------------------------------------------------------------
# TLS (Let's Encrypt via certbot --nginx)
# ---------------------------------------------------------------------------


def test_tls_is_attempted_after_nginx_reload(project, node, monkeypatch):
    """Default-on: after the http-only nginx config is loaded, the
    deploy should run certbot --nginx for each domain. This pins that
    TLS is *attempted* — not whether it succeeds, since CI can't reach
    real Let's Encrypt."""
    monkeypatch.delenv("WATCHTOWER_TLS_DISABLE", raising=False)
    monkeypatch.setenv("WATCHTOWER_LETSENCRYPT_EMAIL", "ops@example.com")

    issued: list[str] = []

    async def fake_ssh(_n, command, _append, prefix=""):
        issued.append(command)
        return True, ""

    with patch.object(builder, "_ssh_run", side_effect=fake_ssh):
        ok, _err = asyncio.run(_apply_nginx_proxy_on_node(
            node, project, ["site.example.com"], lambda _l: None,
        ))

    assert ok is True
    certbot_calls = [c for c in issued if "certbot" in c]
    assert len(certbot_calls) == 1, f"expected one certbot call, got: {certbot_calls}"
    cmd = certbot_calls[0]
    # The whole point of --redirect is to also add the HTTP→HTTPS
    # redirect block. Without it the site would serve HTTP and HTTPS
    # side-by-side and the autonomous-mode probe (HTTP) would
    # misleadingly stay green.
    assert "--redirect" in cmd
    assert "--non-interactive" in cmd
    assert "--agree-tos" in cmd
    assert "ops@example.com" in cmd
    assert "site.example.com" in cmd


def test_tls_skipped_when_disabled_via_env(project, node, monkeypatch):
    """Operator escape hatch. Useful when fronting nginx with Cloudflare
    proxy (orange-cloud) — TLS terminates at Cloudflare, no need for
    Let's Encrypt on the origin."""
    monkeypatch.setenv("WATCHTOWER_TLS_DISABLE", "true")
    monkeypatch.setenv("WATCHTOWER_LETSENCRYPT_EMAIL", "ops@example.com")

    issued: list[str] = []

    async def fake_ssh(_n, command, _append, prefix=""):
        issued.append(command)
        return True, ""

    with patch.object(builder, "_ssh_run", side_effect=fake_ssh):
        asyncio.run(_apply_nginx_proxy_on_node(
            node, project, ["site.example.com"], lambda _l: None,
        ))

    assert not any("certbot" in c for c in issued), (
        f"TLS opt-out failed — certbot ran anyway: {issued}"
    )


def test_tls_skipped_when_no_email_resolvable(project, node, monkeypatch):
    """No env email + no project owner email → skip with a clear log
    line so the operator knows TLS didn't run and how to fix it."""
    monkeypatch.delenv("WATCHTOWER_TLS_DISABLE", raising=False)
    monkeypatch.delenv("WATCHTOWER_LETSENCRYPT_EMAIL", raising=False)
    # The fixture's project has no .owner relationship populated.

    captured: list[str] = []

    async def fake_ssh(_n, command, append, prefix=""):
        return True, ""

    with patch.object(builder, "_ssh_run", side_effect=fake_ssh):
        asyncio.run(_apply_nginx_proxy_on_node(
            node, project, ["site.example.com"], captured.append,
        ))

    # The skip message must point the operator at the env var.
    assert any("WATCHTOWER_LETSENCRYPT_EMAIL" in line for line in captured), (
        f"Expected a skip message naming the env var; got: {captured}"
    )


def test_tls_certbot_failure_does_not_fail_deploy(project, node, monkeypatch):
    """Most common failure: DNS not yet propagated when certbot runs.
    The HTTP-01 challenge fails. The deploy MUST still succeed (the
    container is already reachable; HTTP works; HTTPS is just delayed
    until the next deploy after DNS propagates)."""
    monkeypatch.setenv("WATCHTOWER_LETSENCRYPT_EMAIL", "ops@example.com")

    captured: list[str] = []

    async def fake_ssh(_n, command, _append, prefix=""):
        if "certbot" in command:
            return False, "Detail: DNS problem: NXDOMAIN looking up A for site.example.com"
        return True, ""

    with patch.object(builder, "_ssh_run", side_effect=fake_ssh):
        ok, err = asyncio.run(_apply_nginx_proxy_on_node(
            node, project, ["site.example.com"], captured.append,
        ))

    assert ok is True, f"certbot failure must not fail the deploy. err={err}"
    assert err == ""
    # And the log must tell the operator what happened + how to fix.
    assert any("DNS" in line or "doesn't point" in line for line in captured), (
        f"Expected an actionable failure message; got: {captured}"
    )


def test_tls_runs_per_domain_independently(project, node, monkeypatch):
    """Multi-domain projects: one domain's DNS being unpropagated must
    not block TLS issuance for the others."""
    monkeypatch.setenv("WATCHTOWER_LETSENCRYPT_EMAIL", "ops@example.com")

    certbot_attempts: list[str] = []

    async def fake_ssh(_n, command, _append, prefix=""):
        if "certbot" in command:
            certbot_attempts.append(command)
            # First domain fails (DNS), second succeeds.
            if "good.example.com" in command:
                return True, ""
            return False, "DNS NXDOMAIN"
        return True, ""

    with patch.object(builder, "_ssh_run", side_effect=fake_ssh):
        asyncio.run(_apply_nginx_proxy_on_node(
            node, project, ["bad.example.com", "good.example.com"], lambda _l: None,
        ))

    # Both domains had certbot attempted — failure on bad didn't
    # short-circuit good.
    assert len(certbot_attempts) == 2
    assert any("bad.example.com" in c for c in certbot_attempts)
    assert any("good.example.com" in c for c in certbot_attempts)


# ---------------------------------------------------------------------------
# Cert-email resolver
# ---------------------------------------------------------------------------


# Use plain stubs for the resolver tests because SQLAlchemy guards
# relationship-attribute assignment on managed Project rows — we'd
# need a real User row to satisfy the back-population. Faster + clearer
# to test the resolver directly against the contract it actually needs:
# something with an .owner that may have an .email.

class _StubOwner:
    def __init__(self, email): self.email = email


class _StubProject:
    def __init__(self, owner=None): self.owner = owner


def test_resolve_letsencrypt_email_prefers_env(monkeypatch):
    monkeypatch.setenv("WATCHTOWER_LETSENCRYPT_EMAIL", "from-env@example.com")
    # Even with an owner email present, env wins (operator's explicit override).
    p = _StubProject(owner=_StubOwner("owner@example.com"))
    assert builder._resolve_letsencrypt_email(p) == "from-env@example.com"


def test_resolve_letsencrypt_email_falls_back_to_owner(monkeypatch):
    monkeypatch.delenv("WATCHTOWER_LETSENCRYPT_EMAIL", raising=False)
    p = _StubProject(owner=_StubOwner("owner@example.com"))
    assert builder._resolve_letsencrypt_email(p) == "owner@example.com"


def test_resolve_letsencrypt_email_returns_none_when_unset(monkeypatch):
    monkeypatch.delenv("WATCHTOWER_LETSENCRYPT_EMAIL", raising=False)
    p = _StubProject(owner=None)
    assert builder._resolve_letsencrypt_email(p) is None


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
