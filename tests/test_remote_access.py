"""Tests for the /api/remote-access router.

We never call a real `tailscale` binary — every test patches the
module-level subprocess wrapper and the `shutil.which` shim so the
provider thinks the binary is (or isn't) installed.
"""
from __future__ import annotations

import json

import pytest

from watchtower.api import remote_access


# ── Helpers ──────────────────────────────────────────────────────────────────


def _install_fake_tailscale(monkeypatch, status_payload=None, serve_payload=None, *, installed=True):
    """Patch the Tailscale binary lookup + subprocess runner.

    `status_payload` and `serve_payload` are dicts that will be JSON-
    serialised back to the provider. Pass `None` to simulate a failed
    invocation of the corresponding subcommand.
    """
    # Binary resolution now lives in watchtower.tool_resolver (shared with
    # runtime.py). Patch the `which` shim there; the provider's _binary()
    # delegates to tool_resolver.tailscale_binary().
    from watchtower import tool_resolver
    monkeypatch.setattr(
        tool_resolver.shutil, "which",
        lambda name: "/usr/bin/tailscale" if (installed and name == "tailscale") else None,
    )
    # The resolver falls back to GUI-app bundle paths (e.g. the macOS
    # /Applications/Tailscale.app CLI) when `which` misses. On a dev Mac
    # that path really exists, which would make `installed=False` cases
    # read as installed. Neutralise the fallback's filesystem probe so the
    # `which` shim above is the sole source of truth in tests.
    monkeypatch.setattr(tool_resolver.os.path, "isfile", lambda _p: False)

    def fake_run(cmd, *, timeout=8.0):
        # cmd is the full argv. Switch on the subcommand.
        if not installed:
            return 127, "", "tailscale: not found"
        if cmd[:2] == ["/usr/bin/tailscale", "status"]:
            if status_payload is None:
                return 1, "", "daemon not running"
            return 0, json.dumps(status_payload), ""
        if cmd[:3] == ["/usr/bin/tailscale", "serve", "status"]:
            if serve_payload is None:
                return 1, "", ""
            return 0, json.dumps(serve_payload), ""
        if cmd[:3] == ["/usr/bin/tailscale", "serve", "reset"]:
            return 0, "", ""
        # Enable: `tailscale serve --bg <port>`
        if cmd[:3] == ["/usr/bin/tailscale", "serve", "--bg"]:
            return 0, "", ""
        return 1, "", f"unhandled fake-run command: {cmd}"

    monkeypatch.setattr(remote_access, "_run", fake_run)


# ── Auth ─────────────────────────────────────────────────────────────────────


def test_providers_requires_auth(anon_client):
    r = anon_client.get("/api/remote-access/providers")
    assert r.status_code == 401


def test_enable_requires_auth(anon_client):
    r = anon_client.post(
        "/api/remote-access/providers/tailscale/enable",
        json={"port": 8000},
    )
    assert r.status_code == 401


# ── Provider listing ─────────────────────────────────────────────────────────


def test_providers_lists_tailscale_when_not_installed(client, monkeypatch):
    _install_fake_tailscale(monkeypatch, installed=False)
    r = client.get("/api/remote-access/providers")
    assert r.status_code == 200
    payload = r.json()
    assert len(payload) == 1
    p = payload[0]
    assert p["id"] == "tailscale"
    assert p["name"] == "Tailscale"
    assert p["installed"] is False
    assert p["ready"] is False
    assert p["sharing"] is False
    assert p["install_url"] == "https://tailscale.com/download"
    assert p["hint"]  # should give the user something to do


def test_providers_reports_needs_login(client, monkeypatch):
    """Installed but the user hasn't run `tailscale up` yet."""
    _install_fake_tailscale(
        monkeypatch,
        status_payload={"BackendState": "NeedsLogin", "Self": {"DNSName": ""}},
    )
    r = client.get("/api/remote-access/providers")
    assert r.status_code == 200
    p = r.json()[0]
    assert p["installed"] is True
    assert p["ready"] is False
    assert "sign in" in (p["hint"] or "").lower()


def test_providers_reports_ready_when_logged_in_and_not_sharing(client, monkeypatch):
    _install_fake_tailscale(
        monkeypatch,
        status_payload={
            "BackendState": "Running",
            "Self": {"DNSName": "watchtower-host.example-tail.ts.net."},
        },
        # No active serve config.
        serve_payload={"Web": {}},
    )
    r = client.get("/api/remote-access/providers")
    p = r.json()[0]
    assert p["installed"] is True
    assert p["ready"] is True
    assert p["sharing"] is False
    # URL should reflect the tailnet hostname even when not sharing yet —
    # gives the user a preview of what they'll get.
    assert p["url"] == "https://watchtower-host.example-tail.ts.net"


def test_providers_reports_active_sharing(client, monkeypatch):
    _install_fake_tailscale(
        monkeypatch,
        status_payload={
            "BackendState": "Running",
            "Self": {"DNSName": "watchtower-host.example-tail.ts.net."},
        },
        serve_payload={
            "Web": {
                "watchtower-host.example-tail.ts.net:443": {
                    "Handlers": {"/": {"Proxy": "http://127.0.0.1:8000"}}
                }
            }
        },
    )
    r = client.get("/api/remote-access/providers")
    p = r.json()[0]
    assert p["sharing"] is True
    assert p["url"] == "https://watchtower-host.example-tail.ts.net"


# ── Single-provider lookup ───────────────────────────────────────────────────


def test_get_provider_404_unknown(client, monkeypatch):
    _install_fake_tailscale(monkeypatch)
    r = client.get("/api/remote-access/providers/nope")
    assert r.status_code == 404


def test_get_provider_tailscale(client, monkeypatch):
    _install_fake_tailscale(
        monkeypatch,
        status_payload={
            "BackendState": "Running",
            "Self": {"DNSName": "host.tail.ts.net."},
        },
        serve_payload={"Web": {}},
    )
    r = client.get("/api/remote-access/providers/tailscale")
    assert r.status_code == 200
    assert r.json()["id"] == "tailscale"


# ── Enable / disable ─────────────────────────────────────────────────────────


def test_enable_tailscale_returns_updated_state(client, monkeypatch):
    # First call returns "not sharing". After enable, the next status
    # poll should show the active serve URL — simulate that by mutating
    # the serve payload between calls.
    state = {"shared": False}

    def fake_run(cmd, *, timeout=8.0):
        if cmd[:2] == ["/usr/bin/tailscale", "status"]:
            return 0, json.dumps({
                "BackendState": "Running",
                "Self": {"DNSName": "host.tail.ts.net."},
            }), ""
        if cmd[:3] == ["/usr/bin/tailscale", "serve", "status"]:
            if state["shared"]:
                return 0, json.dumps({
                    "Web": {
                        "host.tail.ts.net:443": {
                            "Handlers": {"/": {"Proxy": "http://127.0.0.1:8000"}}
                        }
                    }
                }), ""
            return 0, json.dumps({"Web": {}}), ""
        if cmd[:3] == ["/usr/bin/tailscale", "serve", "--bg"]:
            state["shared"] = True
            return 0, "", ""
        return 1, "", f"unexpected cmd: {cmd}"

    from watchtower import tool_resolver
    monkeypatch.setattr(tool_resolver.shutil, "which", lambda n: "/usr/bin/tailscale")
    monkeypatch.setattr(remote_access, "_run", fake_run)

    r = client.post(
        "/api/remote-access/providers/tailscale/enable",
        json={"port": 8000},
    )
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["sharing"] is True
    assert p["url"] == "https://host.tail.ts.net"


def test_enable_tailscale_surfaces_cli_error(client, monkeypatch):
    from watchtower import tool_resolver
    monkeypatch.setattr(tool_resolver.shutil, "which", lambda n: "/usr/bin/tailscale")

    def fake_run(cmd, *, timeout=8.0):
        if cmd[:2] == ["/usr/bin/tailscale", "status"]:
            return 0, json.dumps({
                "BackendState": "Running",
                "Self": {"DNSName": "host.tail.ts.net."},
            }), ""
        if cmd[:3] == ["/usr/bin/tailscale", "serve", "--bg"]:
            return 1, "", "must run as root"
        return 0, json.dumps({"Web": {}}), ""

    monkeypatch.setattr(remote_access, "_run", fake_run)

    r = client.post(
        "/api/remote-access/providers/tailscale/enable",
        json={"port": 8000},
    )
    assert r.status_code == 400
    assert "root" in r.json()["detail"].lower()


def test_enable_rejects_when_binary_missing(client, monkeypatch):
    _install_fake_tailscale(monkeypatch, installed=False)
    r = client.post(
        "/api/remote-access/providers/tailscale/enable",
        json={"port": 8000},
    )
    assert r.status_code == 400
    assert "not installed" in r.json()["detail"].lower()


def test_enable_validates_port_range(client, monkeypatch):
    _install_fake_tailscale(
        monkeypatch,
        status_payload={"BackendState": "Running", "Self": {"DNSName": "host.tail.ts.net."}},
        serve_payload={"Web": {}},
    )
    r = client.post(
        "/api/remote-access/providers/tailscale/enable",
        json={"port": 99999},
    )
    assert r.status_code == 422


def test_disable_tailscale(client, monkeypatch):
    _install_fake_tailscale(
        monkeypatch,
        status_payload={"BackendState": "Running", "Self": {"DNSName": "host.tail.ts.net."}},
        serve_payload={"Web": {}},
    )
    r = client.post("/api/remote-access/providers/tailscale/disable")
    assert r.status_code == 200
    assert r.json()["sharing"] is False


# ── Default port ─────────────────────────────────────────────────────────────


def test_default_port_returns_watchtower_port(client, monkeypatch):
    monkeypatch.setenv("WATCHTOWER_PORT", "9001")
    r = client.get("/api/remote-access/default-port")
    assert r.status_code == 200
    assert r.json() == {"port": 9001}


def test_default_port_falls_back_to_8000(client, monkeypatch):
    monkeypatch.delenv("WATCHTOWER_PORT", raising=False)
    r = client.get("/api/remote-access/default-port")
    assert r.status_code == 200
    assert r.json() == {"port": 8000}


# ── Audit ────────────────────────────────────────────────────────────────────


def test_enable_writes_audit_event(client, db_session, monkeypatch):
    """Enabling a provider should leave a record in the audit log."""
    from watchtower.database import AuditEvent

    _install_fake_tailscale(
        monkeypatch,
        status_payload={"BackendState": "Running", "Self": {"DNSName": "host.tail.ts.net."}},
        serve_payload={"Web": {}},
    )

    r = client.post(
        "/api/remote-access/providers/tailscale/enable",
        json={"port": 8000},
    )
    assert r.status_code == 200

    events = (
        db_session.query(AuditEvent)
        .filter(AuditEvent.action == "remote_access.tailscale.enable")
        .all()
    )
    assert len(events) == 1
    assert events[0].entity_type == "remote_access_provider"
