"""Tests for GET /api/runtime/metrics/system.

Covers the cross-platform (Linux /proc + macOS sysctl/vm_stat) memory read, the
new CPU block, and the non-blocking stateful process-CPU sampler. The metric
helpers shell out on macOS, so we assert on shape/invariants rather than exact
values, and unit-test the sampler's delta logic directly.
"""
from __future__ import annotations

import os

from fastapi.testclient import TestClient

from watchtower.api import runtime as runtime_module


def test_metrics_returns_full_shape(client: TestClient):
    r = client.get("/api/runtime/metrics/system")
    assert r.status_code == 200
    body = r.json()

    # Every top-level block the SPA consumes must be present.
    for block in ("ram", "swap", "cpu", "process"):
        assert block in body, f"missing block: {block}"

    cpu = body["cpu"]
    assert cpu["count"] == (os.cpu_count() or 1)
    assert 0.0 <= cpu["system_percent"] <= 100.0
    assert 0.0 <= cpu["process_percent"] <= 100.0

    proc = body["process"]
    assert proc["label"] == "WatchTower API"
    assert proc["rss_mb"] >= 0.0
    # Process CPU is mirrored into both cpu.* and process.* for the two UIs.
    assert proc["cpu_percent"] == cpu["process_percent"]


def test_metrics_requires_auth(anon_client: TestClient):
    r = anon_client.get("/api/runtime/metrics/system")
    assert r.status_code == 401


def test_read_meminfo_reports_total_on_this_host():
    """Whatever platform CI runs on, we should get a non-zero MemTotal — this is
    the exact regression that left macOS showing 0 for all system RAM."""
    mi = runtime_module._read_meminfo()
    assert mi.get("MemTotal", 0) > 0


def test_cpu_percent_first_call_has_no_process_interval():
    """With no prior snapshot, process CPU must be 0.0 (no window to measure),
    while system CPU (load-average based) can be reported immediately."""
    runtime_module._last_cpu_sample = None
    proc, system = runtime_module._cpu_percent()
    assert proc == 0.0
    assert 0.0 <= system <= 100.0
    # The call must have stored a snapshot for the next delta.
    assert runtime_module._last_cpu_sample is not None


def test_cpu_percent_computes_a_delta_on_second_call(monkeypatch):
    """Second call computes busy-CPU / wall / ncpu. Feed a synthetic prior
    snapshot and controlled os.times()/monotonic so the math is deterministic."""
    ncpu = os.cpu_count() or 1

    class FakeTimes:
        user = 1.0
        system = 0.0

    # Prior snapshot: 0 cpu-seconds at wall t=0. Now: 0.5 cpu-seconds at wall t=1.
    runtime_module._last_cpu_sample = (0.0, 0.0)
    monkeypatch.setattr(runtime_module.os, "times", lambda: FakeTimes())
    monkeypatch.setattr(runtime_module.time, "monotonic", lambda: 1.0)

    # FakeTimes gives user+system = 1.0 cpu-seconds over 1.0s wall → 1 core busy.
    proc, _ = runtime_module._cpu_percent()
    expected = round(min(1.0 / 1.0 / ncpu * 100.0, 100.0), 1)
    assert proc == expected
