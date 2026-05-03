"""Regression tests for the GitHub Device Flow endpoint.

History: 1.6.2 added a module-level ``__getattr__`` lazy-loader for
``requests`` to shave cold-start time, but Python's PEP 562 only fires
``__getattr__`` for *external* attribute access on the module — bare
name lookups *inside* the module (``requests.post(...)``,
``except requests.RequestException``) hit ``LOAD_GLOBAL`` and skip
``__getattr__`` entirely. Result: every device-flow start call ended in
``NameError`` → 500. No test covered the success or RequestException
path, so it shipped to 1.6.2 and 1.6.3.

These tests pin both the success and the upstream-network-error paths.
"""

from __future__ import annotations

from unittest.mock import patch, MagicMock


def _fake_response(status: int = 200, payload: dict | None = None) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = payload or {
        "device_code": "abc123",
        "user_code": "WXYZ-1234",
        "verification_uri": "https://github.com/login/device",
        "expires_in": 900,
        "interval": 5,
    }
    resp.text = "" if status < 400 else "github error body"
    return resp


def test_device_flow_start_returns_user_code(anon_client, monkeypatch):
    """Success path — endpoint returns the user_code from GitHub."""
    monkeypatch.setenv("WATCHTOWER_GITHUB_DEVICE_CLIENT_ID", "Iv1.public-test-id")

    with patch(
        "watchtower.api.enterprise.requests.post",
        return_value=_fake_response(200),
    ):
        resp = anon_client.post("/api/auth/github/device/start", json={})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["user_code"] == "WXYZ-1234"
    assert body["verification_uri"] == "https://github.com/login/device"


def test_device_flow_start_handles_network_failure(anon_client, monkeypatch):
    """The except branch must resolve ``requests.RequestException`` cleanly.

    This is the path that crashed with NameError in 1.6.2/1.6.3 because
    the lazy-loader didn't service in-module bare-name references. The
    handler must return 502 (not 500) when the upstream call raises.
    """
    monkeypatch.setenv("WATCHTOWER_GITHUB_DEVICE_CLIENT_ID", "Iv1.public-test-id")

    import requests as real_requests

    with patch(
        "watchtower.api.enterprise.requests.post",
        side_effect=real_requests.RequestException("boom"),
    ):
        resp = anon_client.post("/api/auth/github/device/start", json={})

    assert resp.status_code == 502, resp.text
    assert "Unable to reach GitHub" in resp.json()["detail"]


