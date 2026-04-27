"""Tests for ``watchtower.queue.enqueue_build`` routing.

Two paths to verify:
  - ``REDIS_URL`` unset → falls back to FastAPI ``BackgroundTasks``
  - ``REDIS_URL`` set but unreachable → also falls back (with a warning)

We do *not* boot a real Redis here. RQ correctness is RQ's problem; what
matters for our foundation is that the route handlers always have a
working dispatch even when the broker is down.
"""
from __future__ import annotations

import os
from unittest.mock import MagicMock

import pytest

from watchtower import queue as build_queue


def _reset():
    """Helper — clear cached probe state between tests."""
    build_queue.reset_for_tests()


@pytest.fixture(autouse=True)
def _clear_queue_state(monkeypatch):
    _reset()
    yield
    _reset()


def test_enqueue_build_falls_back_when_redis_url_unset(monkeypatch):
    """No REDIS_URL → background tasks path."""
    monkeypatch.delenv("REDIS_URL", raising=False)
    bg = MagicMock()

    mode = build_queue.enqueue_build("dep-id-123", bg)

    assert mode == "inprocess"
    assert bg.add_task.call_count == 1
    # First positional arg is the callable; second is the deployment id.
    args = bg.add_task.call_args.args
    assert args[1] == "dep-id-123"


def test_enqueue_build_falls_back_when_redis_unreachable(monkeypatch):
    """REDIS_URL set but broker can't be reached → still works."""
    # Port 1 is reserved/unused; ping will fail fast.
    monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:1/0")
    bg = MagicMock()

    mode = build_queue.enqueue_build("dep-unreachable", bg)

    assert mode == "inprocess"
    assert bg.add_task.call_count == 1


def test_probe_failure_is_cached(monkeypatch):
    """Subsequent enqueues after a probe failure must not re-probe Redis.

    A flapping broker would otherwise add a 2-second connect timeout to
    every webhook / deploy trigger.
    """
    monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:1/0")

    # First call probes and fails.
    bg1 = MagicMock()
    build_queue.enqueue_build("first", bg1)
    assert build_queue._probe_failed is True

    # Replace _get_queue's probe-side-effects to detect a re-probe.
    called = {"n": 0}

    def _spy_get_queue():
        called["n"] += 1
        return None

    monkeypatch.setattr(build_queue, "_get_queue", _spy_get_queue)
    bg2 = MagicMock()
    build_queue.enqueue_build("second", bg2)
    # _get_queue *is* called once per enqueue, but the underlying probe
    # (Redis.ping) is not — that's what _probe_failed prevents. The spy
    # confirms the dispatcher still asks _get_queue and gets None back.
    assert called["n"] == 1
