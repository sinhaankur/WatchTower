"""Unit tests for the local-node deploy fast path (1.13.0+).

End-to-end deploy is hard to test without real SSH + repo + builder
infrastructure, so this file focuses on the cheap-but-load-bearing
helpers:

  * ``_is_local_node`` — the predicate that switches deploy behavior
    between the SSH path and the local-subprocess path. If this
    misclassifies a hostname, every deploy goes the wrong way.
  * ``check_ssh_connectivity`` for local nodes — exercises the file-
    write probe (no SSH involved) so registering a local node and
    pressing "Test connection" gives a useful answer.
"""
from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import pytest

from watchtower.builder import _is_local_node, _local_deploy_path, check_ssh_connectivity


@dataclass
class _Node:
    """Minimal stand-in for an OrgNode row.

    The functions under test only read .host / .remote_path / .provider, so
    we don't need to spin up a database or fixture.
    """

    host: Optional[str] = None
    remote_path: Optional[str] = None
    port: int = 22
    user: str = "watchtower"
    ssh_key_path: Optional[str] = None
    provider: Optional[str] = None


@pytest.mark.parametrize(
    "host, expected",
    [
        ("127.0.0.1", True),
        ("localhost", True),
        ("LOCALHOST", True),  # case-insensitive on purpose
        ("  127.0.0.1  ", True),  # tolerate accidental whitespace from forms
        ("::1", True),
        ("192.168.1.10", False),
        ("example.com", False),
        ("", False),
        (None, False),
    ],
)
def test_is_local_node_classifies_correctly(host, expected):
    """Misclassification here = wrong deploy code path. Pin it down."""
    assert _is_local_node(_Node(host=host)) is expected


def test_provider_local_marks_node_local_regardless_of_host():
    """The one-click 'Use this PC' flow sets provider='local'. That marker is
    authoritative — a node with it must take the local (no-SSH) path even if
    its host string wouldn't otherwise classify as local."""
    assert _is_local_node(_Node(host="127.0.0.1", provider="local")) is True
    # Even a non-loopback host is treated local when explicitly marked.
    assert _is_local_node(_Node(host="10.0.0.5", provider="local")) is True
    assert _is_local_node(_Node(host="10.0.0.5", provider=None)) is False


def test_local_deploy_path_falls_back_when_empty():
    """An empty remote_path must NOT resolve to '/' (which would make rsync
    --delete and the container bind-mount target the filesystem root). It
    falls back to a safe per-machine directory under the data dir."""
    node = _Node(host="127.0.0.1", provider="local", remote_path="")
    p = _local_deploy_path(node)
    assert p not in ("", "/")
    assert p.endswith("deployments/this-pc")


def test_local_deploy_path_honors_writable_explicit_path(tmp_path):
    """A configured path that exists / can be created AND is writable is used
    as-is (trailing slash trimmed)."""
    target = tmp_path / "site"
    node = _Node(host="127.0.0.1", provider="local", remote_path=f"{target}/")
    assert _local_deploy_path(node) == str(target)


def test_local_deploy_path_falls_back_when_unwritable(monkeypatch, tmp_path):
    """Regression ('simple deployment doesn't work'): a legacy local node with
    an UNWRITABLE remote_path (e.g. /usr/local/var/watchtower/agent → EACCES)
    must fall back to the data-dir deploy path, not fail the rsync."""
    monkeypatch.setenv("WATCHTOWER_DATA_DIR", str(tmp_path))
    # A path the test user cannot create/write under.
    node = _Node(host="127.0.0.1", provider="local",
                 remote_path="/usr/local/var/watchtower/agent")
    resolved = _local_deploy_path(node)
    assert resolved != "/usr/local/var/watchtower/agent"
    assert resolved.endswith("deployments/this-pc")


def test_check_ssh_connectivity_local_node_writable_path(tmp_path: Path):
    """Local-node 'connectivity' is really a writability probe.

    A local node has no SSH to test. The user pressing 'Test connection'
    on a freshly-registered local node deserves a real answer about
    whether deploys will work — i.e., 'is remote_path actually
    writable?'. We verify the helper returns success and that the probe
    file gets cleaned up so it doesn't accumulate.
    """
    node = _Node(host="127.0.0.1", remote_path=str(tmp_path / "deploy"))
    ok, msg = check_ssh_connectivity(node)
    assert ok, f"expected success, got: {msg}"
    assert "writable" in msg.lower()
    # Probe file must not survive — otherwise repeated test-connection
    # clicks would leave litter in the deploy dir.
    leftovers = list((tmp_path / "deploy").iterdir())
    assert leftovers == [], f"probe file left behind: {leftovers}"


def test_check_ssh_connectivity_local_node_unwritable_path_falls_back(monkeypatch, tmp_path):
    """A legacy local node with an UNWRITABLE configured remote_path now reports
    HEALTHY, because the deploy transparently falls back to the writable
    data-dir path. This is the corrected behaviour for the
    '/usr/local/var/watchtower/agent → Permission denied' bug — the health
    check must agree with what the deploy will actually do.
    """
    monkeypatch.setenv("WATCHTOWER_DATA_DIR", str(tmp_path))
    node = _Node(host="localhost", remote_path="/usr/local/var/watchtower/agent")
    ok, msg = check_ssh_connectivity(node)
    assert ok, f"expected healthy via fallback, got: {msg}"
    assert "writable" in msg.lower()
    # And the reported path is the fallback, not the unwritable original.
    assert "/usr/local/var" not in msg


def test_check_ssh_connectivity_local_node_no_remote_path_uses_fallback(monkeypatch, tmp_path):
    """An empty/None remote_path now resolves to the writable data-dir deploy
    path and reports healthy — a local node always has somewhere to deploy."""
    monkeypatch.setenv("WATCHTOWER_DATA_DIR", str(tmp_path))
    for path in ("", None):
        node = _Node(host="127.0.0.1", remote_path=path)
        ok, msg = check_ssh_connectivity(node)
        assert ok
        assert "writable" in msg.lower()
