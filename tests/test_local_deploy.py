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

from watchtower.builder import _is_local_node, check_ssh_connectivity


@dataclass
class _Node:
    """Minimal stand-in for an OrgNode row.

    The functions under test only read .host / .remote_path, so we
    don't need to spin up a database or fixture.
    """

    host: Optional[str] = None
    remote_path: Optional[str] = None
    port: int = 22
    user: str = "watchtower"
    ssh_key_path: Optional[str] = None


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


def test_check_ssh_connectivity_local_node_unwritable_path():
    """A non-writable local path should fail loud, not silently succeed.

    /proc/1 exists on Linux but isn't writable for any normal user.
    On macOS where /proc doesn't exist, ``mkdir -p`` would create it
    elsewhere, so we use a path under a read-only file (which can't
    have children) to force the failure portably.
    """
    with tempfile.NamedTemporaryFile() as f:
        # Trying to mkdir a child of a regular file always fails.
        node = _Node(host="localhost", remote_path=os.path.join(f.name, "subdir"))
        ok, msg = check_ssh_connectivity(node)
        assert not ok
        assert "not writable" in msg.lower() or "not a directory" in msg.lower()


def test_check_ssh_connectivity_local_node_no_remote_path():
    """remote_path empty string / None should still report registered.

    A user might add a local node before configuring a deploy path.
    The connectivity check shouldn't crash — it should report 'no
    remote_path set' so the UI can prompt them to set one.
    """
    for path in ("", None):
        node = _Node(host="127.0.0.1", remote_path=path)
        ok, msg = check_ssh_connectivity(node)
        assert ok
        assert "no remote_path" in msg.lower()
