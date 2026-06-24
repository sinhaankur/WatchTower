"""Unit tests for the Cloudflare Tunnel helpers in cloudflare_dns.

These verify the request shapes WatchTower sends for remotely-managed
tunnels (config_src=cloudflare), without hitting the network — the
``_cf_*`` HTTP helpers are patched to return canned Cloudflare-shaped
payloads. The go-live orchestration tests cover the wiring; these pin
the API contract each helper depends on.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from watchtower import cloudflare_dns as cf


def test_create_tunnel_creates_when_none_exists():
    calls = {}

    def fake_get(token, path, params=None):
        if path.endswith("/cfd_tunnel") and params and "name" in params:
            return {"result": []}  # no existing tunnel
        if path.endswith("/token"):
            return {"result": "connector-token-xyz"}
        raise AssertionError(f"unexpected GET {path} {params}")

    def fake_post(token, path, body):
        calls["post_body"] = body
        return {"result": {"id": "tunnel-abc"}}

    with patch.object(cf, "_cf_get", side_effect=fake_get), \
         patch.object(cf, "_cf_post", side_effect=fake_post):
        res = cf.create_tunnel("tok", "acct-1", "wt-myapp")

    assert res.tunnel_id == "tunnel-abc"
    assert res.token == "connector-token-xyz"
    assert res.name == "wt-myapp"
    # Remotely-managed tunnels must request config_src=cloudflare.
    assert calls["post_body"]["config_src"] == "cloudflare"
    assert calls["post_body"]["name"] == "wt-myapp"


def test_create_tunnel_reuses_existing_by_name():
    """Re-running go-live shouldn't pile up tunnels — an existing live
    tunnel with the same name is reused (no POST)."""
    def fake_get(token, path, params=None):
        if path.endswith("/cfd_tunnel") and params and "name" in params:
            return {"result": [{"id": "existing-1", "name": "wt-myapp", "deleted_at": None}]}
        if path.endswith("/token"):
            return {"result": "tok-reused"}
        raise AssertionError(f"unexpected GET {path}")

    def fake_post(token, path, body):  # pragma: no cover - must not be called
        raise AssertionError("should not create a new tunnel when one exists")

    with patch.object(cf, "_cf_get", side_effect=fake_get), \
         patch.object(cf, "_cf_post", side_effect=fake_post):
        res = cf.create_tunnel("tok", "acct-1", "wt-myapp")

    assert res.tunnel_id == "existing-1"
    assert res.token == "tok-reused"


def test_create_tunnel_requires_account_id():
    with pytest.raises(cf.CloudflareDnsError) as ei:
        cf.create_tunnel("tok", "", "wt-myapp")
    assert ei.value.status == 400


def test_configure_tunnel_ingress_sends_single_rule_plus_catchall():
    captured = {}

    def fake_put(token, path, body):
        captured["path"] = path
        captured["body"] = body
        return {"result": {}}

    with patch.object(cf, "_cf_put", side_effect=fake_put):
        cf.configure_tunnel_ingress("tok", "acct-1", "tun-1", "app.example.com", "http://localhost:8080")

    assert "/cfd_tunnel/tun-1/configurations" in captured["path"]
    ingress = captured["body"]["config"]["ingress"]
    assert ingress[0] == {"hostname": "app.example.com", "service": "http://localhost:8080"}
    assert ingress[-1] == {"service": "http_status:404"}  # required catch-all


def test_sync_cname_creates_proxied_record_when_absent():
    def fake_get(token, path, params=None):
        if "/dns_records" in path:
            return {"result": []}  # no existing CNAME
        raise AssertionError(f"unexpected GET {path}")

    captured = {}

    def fake_post(token, path, body):
        captured["body"] = body
        return {"result": {"id": "cname-1", "zone_name": "example.com"}}

    with patch.object(cf, "_cf_get", side_effect=fake_get), \
         patch.object(cf, "_cf_post", side_effect=fake_post):
        res = cf.sync_cname(
            "tok", "app.example.com", "tun-1.cfargotunnel.com",
            existing_zone_id="zone-1",
        )

    assert res.record_id == "cname-1"
    assert captured["body"]["type"] == "CNAME"
    assert captured["body"]["content"] == "tun-1.cfargotunnel.com"
    assert captured["body"]["proxied"] is True  # tunnels are always proxied


def test_delete_tunnel_treats_404_as_success():
    def fake_delete(token, path):
        raise cf.CloudflareDnsError(404, "not found")

    with patch.object(cf, "_cf_delete", side_effect=fake_delete):
        cf.delete_tunnel("tok", "acct-1", "tun-gone")  # must not raise


# ── builder.install_cloudflared_tunnel_on_node ────────────────────────────────

def test_install_cloudflared_runs_install_and_service_and_redacts_token():
    """The installer should run the install + `service install <token>` over
    SSH and never leak the connector token into the log."""
    import asyncio
    from unittest.mock import patch as _patch
    from watchtower import builder
    from watchtower.database import OrgNode

    node = OrgNode(name="n1", host="1.2.3.4", user="deploy", port=22, remote_path="/srv")
    cmds: list[str] = []
    log_lines: list[str] = []

    async def fake_ssh_run(_node, command, append, prefix=""):
        cmds.append(command)
        # Only the `service install` step echoes the token (that's the call
        # the installer wraps with the redacting append). Simulate that so
        # the test verifies the mask actually fires on the right call.
        if "service install" in command:
            append("connected with token SECRET-TOKEN-123")
        return True, ""

    with _patch.object(builder, "_ssh_run", side_effect=fake_ssh_run):
        ok, err = asyncio.run(
            builder.install_cloudflared_tunnel_on_node(node, "SECRET-TOKEN-123", log_lines.append)
        )

    assert ok is True and err == ""
    # install step + service-install step + enable step.
    assert any("cloudflared" in c and "install" in c for c in cmds)
    assert any("cloudflared service install" in c for c in cmds)
    # The token must never appear verbatim in the captured log.
    assert all("SECRET-TOKEN-123" not in line for line in log_lines)


def test_install_cloudflared_empty_token_is_rejected():
    import asyncio
    from watchtower import builder
    from watchtower.database import OrgNode

    node = OrgNode(name="n1", host="1.2.3.4", user="deploy", port=22, remote_path="/srv")
    ok, err = asyncio.run(builder.install_cloudflared_tunnel_on_node(node, "", (lambda _l: None)))
    assert ok is False
    assert "token" in err.lower()


def test_install_command_normalises_arch_for_non_debian_nodes():
    """The install command must map uname -m values (x86_64/aarch64) to the
    cloudflared release asset names (amd64/arm64) — otherwise the curl
    fallback 404s on any node without dpkg (RHEL/Alpine/etc)."""
    import asyncio
    from unittest.mock import patch as _patch
    from watchtower import builder
    from watchtower.database import OrgNode

    node = OrgNode(name="n1", host="1.2.3.4", user="deploy", port=22, remote_path="/srv")
    cmds: list[str] = []

    async def fake_ssh_run(_node, command, append, prefix=""):
        cmds.append(command)
        return True, ""

    with _patch.object(builder, "_ssh_run", side_effect=fake_ssh_run):
        asyncio.run(builder.install_cloudflared_tunnel_on_node(node, "tok", lambda _l: None))

    install_cmd = next(c for c in cmds if "cloudflared-linux" in c)
    # The arch normalisation must be present and cover the uname -m forms.
    assert "x86_64) CFARCH=amd64" in install_cmd
    assert "aarch64) CFARCH=arm64" in install_cmd
    # And it must download by the normalised name, not raw ${ARCH}.
    assert "cloudflared-linux-${CFARCH}" in install_cmd
    # Unknown arch fails loudly rather than 404-ing a bad URL.
    assert "unsupported arch" in install_cmd
