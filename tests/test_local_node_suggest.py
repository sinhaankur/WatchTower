"""Tests for the GET /api/runtime/local-node/suggest-config endpoint.

This is the backend probe behind the LocalNode "Use This PC as a Server"
form's auto-detect — it's what fills in the deploy path, profile,
reload command, etc. without the user having to know any of that.
The endpoint should be cheap, side-effect-free, and return a dict
with every field the React form binds to.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


# Required keys on every successful response. Adding a new field to the
# endpoint? Add it here too — keeps the SPA's form binding contract
# explicit instead of relying on every response carrying every key.
_REQUIRED_KEYS = {
    "os_type",
    "node_name",
    "deploy_path",
    "user",
    "host",
    "port",
    "ssh_key_path",
    "reload_command",
    "profile_id",
    "max_concurrent_deployments",
    "is_primary",
    "detected",
}


def test_suggest_config_returns_full_payload(client: TestClient):
    r = client.get("/api/runtime/local-node/suggest-config")
    assert r.status_code == 200
    body = r.json()
    missing = _REQUIRED_KEYS - set(body)
    assert not missing, f"Response missing keys: {missing}"


def test_suggest_config_profile_id_is_known(client: TestClient):
    r = client.get("/api/runtime/local-node/suggest-config")
    assert r.json()["profile_id"] in {"light", "standard", "full"}


def test_suggest_config_detected_block_has_runtime_flags(client: TestClient):
    """The 'detected' subfield drives the SPA banner that says
    "Auto-detected: Standard based on your CPU + RAM" — it must
    carry boolean podman/docker flags and numeric cpus/ram_gb."""
    r = client.get("/api/runtime/local-node/suggest-config")
    detected = r.json()["detected"]
    assert isinstance(detected.get("podman_installed"), bool)
    assert isinstance(detected.get("docker_installed"), bool)
    assert isinstance(detected.get("cpus"), int)
    assert detected["cpus"] >= 1
    assert isinstance(detected.get("ram_gb"), (int, float))


def test_suggest_config_loopback_host(client: TestClient):
    """The "use this PC" path is always loopback — never expose
    anything externally by accident."""
    body = client.get("/api/runtime/local-node/suggest-config").json()
    assert body["host"] == "127.0.0.1"
    assert body["port"] == 22


def test_suggest_config_requires_auth(anon_client: TestClient):
    r = anon_client.get("/api/runtime/local-node/suggest-config")
    assert r.status_code == 401
