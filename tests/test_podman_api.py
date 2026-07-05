"""Local Podman management: /api/podman/* + podman_runtime arg building.

All podman invocations are mocked at the `_run` seam (same approach as
the managed-DB runtime tests) — these tests pin WHAT argv we build and
HOW failures surface, not podman's own behaviour.
"""
from __future__ import annotations

import json

import pytest

from watchtower import podman_runtime as rt


@pytest.fixture()
def recorded(monkeypatch):
    """Capture every podman argv; respond per-command."""
    calls: list[list[str]] = []

    responses = {
        "ps": (0, json.dumps([
            {
                "Id": "abc123def456789",
                "Names": ["web-1"],
                "Image": "nginx:alpine",
                "State": "running",
                "Status": "Up 2 hours",
                "PodName": "",
                "Ports": [{"host_port": 8080, "container_port": 80}],
                "Labels": {"watchtower.managed": "true", "watchtower.project": "p-1"},
            }
        ]), ""),
        "pod": (0, json.dumps([
            {
                "Id": "fedcba987654321",
                "Name": "app-pod",
                "Status": "Running",
                "Containers": [{"Id": "abc", "Names": "web-1", "Status": "running"}],
                "Labels": {"watchtower.managed": "true"},
            }
        ]), ""),
        "run": (0, "abc123def456789\n", ""),
        "logs": (0, "hello from container\n", ""),
        "default": (0, "", ""),
    }

    def fake_run(args, *, timeout=60.0):
        calls.append(list(args))
        sub = args[1] if len(args) > 1 else ""
        if sub == "pod" and len(args) > 2 and args[2] == "create":
            return responses["run"]
        return responses.get(sub, responses["default"])

    monkeypatch.setattr(rt, "_run", fake_run)
    monkeypatch.setattr(rt, "_podman_path", lambda: "/usr/bin/podman")
    return calls


# ── Validation (no podman needed) ────────────────────────────────────────────


def test_flag_injection_rejected(recorded):
    """A name starting with '-' must never reach argv."""
    with pytest.raises(rt.PodmanError):
        rt.create_container(name="--privileged", image="nginx:alpine")
    with pytest.raises(rt.PodmanError):
        rt.create_container(name="ok", image="--volume=/:/host")
    with pytest.raises(rt.PodmanError):
        rt.container_action("-rf", "remove")
    with pytest.raises(rt.PodmanError):
        rt.create_pod(name="-x")
    assert recorded == []  # nothing executed


def test_env_key_and_volume_validation(recorded):
    with pytest.raises(rt.PodmanError):
        rt.create_container(name="ok", image="nginx", env={"BAD-KEY": "v"})
    with pytest.raises(rt.PodmanError):
        rt.create_container(name="ok", image="nginx", volumes=[{"host": "relative", "container": "/data"}])
    with pytest.raises(rt.PodmanError):
        rt.create_container(name="ok", image="nginx", ports=[{"host": 99999, "container": 80}])


def test_create_container_builds_expected_argv(recorded):
    rt.create_container(
        name="web-1",
        image="nginx:alpine",
        ports=[{"host": 8080, "container": 80}],
        env={"FOO": "bar"},
        volumes=[{"host": "/tmp/data", "container": "/data"}],
        restart_policy="always",
        project_id="p-1",
        project_name="My Site",
    )
    argv = recorded[-1]
    assert argv[:4] == ["/usr/bin/podman", "run", "-d", "--name"]
    assert "web-1" in argv
    assert "watchtower.managed=true" in argv
    assert "watchtower.project=p-1" in argv
    assert "8080:80" in argv
    assert "FOO=bar" in argv
    assert "/tmp/data:/data" in argv
    assert ["--restart", "always"] == argv[argv.index("--restart"):argv.index("--restart") + 2]
    assert argv[-1] == "nginx:alpine"


def test_pod_membership_excludes_restart_and_ports(recorded):
    """--restart and -p conflict with --pod (the pod owns both)."""
    rt.create_container(name="db-1", image="postgres:16", pod="app-pod",
                        ports=[{"host": 5432, "container": 5432}])
    argv = recorded[-1]
    assert "--pod" in argv and "app-pod" in argv
    assert "--restart" not in argv
    assert "-p" not in argv


# ── API endpoints ────────────────────────────────────────────────────────────


def test_status_reports_not_installed(client, monkeypatch):
    monkeypatch.setattr(rt, "_podman_path", lambda: None)
    r = client.get("/api/podman/status")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is False
    assert "Install" in body["hint"]


def test_containers_list_normalises_fields(client, recorded):
    r = client.get("/api/podman/containers")
    assert r.status_code == 200
    c = r.json()[0]
    assert c["name"] == "web-1"
    assert c["id"] == "abc123def456"  # truncated to 12
    assert c["ports"] == [{"host": 8080, "container": 80}]
    assert c["managed"] is True
    assert c["project_id"] == "p-1"


def test_create_container_endpoint_and_audit(client, recorded, db_session):
    r = client.post("/api/podman/containers", json={
        "name": "web-2",
        "image": "nginx:alpine",
        "ports": [{"host": 8081, "container": 80}],
    })
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "web-2"

    from watchtower.database import AuditEvent
    row = db_session.query(AuditEvent).filter(AuditEvent.action == "podman.container_create").first()
    assert row is not None


def test_container_action_validates_verb(client, recorded):
    assert client.post("/api/podman/containers/web-1/action", json={"action": "stop"}).status_code == 200
    assert client.post("/api/podman/containers/web-1/action", json={"action": "explode"}).status_code == 400


def test_pods_roundtrip(client, recorded):
    r = client.get("/api/podman/pods")
    assert r.status_code == 200
    assert r.json()[0]["name"] == "app-pod"

    r = client.post("/api/podman/pods", json={
        "name": "new-pod",
        "ports": [{"host": 3000, "container": 3000}],
    })
    assert r.status_code == 200, r.text
    argv = recorded[-1]
    assert argv[1:3] == ["pod", "create"]
    assert "3000:3000" in argv


def test_create_with_foreign_project_404s(client, recorded):
    r = client.post("/api/podman/containers", json={
        "name": "web-3",
        "image": "nginx:alpine",
        "project_id": "00000000-0000-0000-0000-000000000001",
    })
    assert r.status_code == 404


def test_podman_failure_maps_to_400_not_500(client, monkeypatch):
    monkeypatch.setattr(rt, "_podman_path", lambda: "/usr/bin/podman")
    monkeypatch.setattr(rt, "_run", lambda args, timeout=60.0: (125, "", "cannot connect to socket"))
    r = client.get("/api/podman/containers")
    assert r.status_code == 400
    assert "socket" in r.json()["detail"]


# ── Live log streaming ───────────────────────────────────────────────────────


class _FakePopen:
    """Stand-in for subprocess.Popen that replays canned log lines."""

    def __init__(self, args, **kwargs):
        self.args = args
        self.stdout = iter(["line one\n", "line two\n"])
        self.terminated = False

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return 0

    def kill(self):  # pragma: no cover — only on wait timeout
        pass


def test_stream_container_logs_follows_and_yields_lines(monkeypatch):
    monkeypatch.setattr(rt, "_podman_path", lambda: "/usr/bin/podman")
    captured = {}

    def fake_popen(args, **kwargs):
        captured["args"] = args
        return _FakePopen(args, **kwargs)

    monkeypatch.setattr(rt.subprocess, "Popen", fake_popen)

    lines = list(rt.stream_container_logs("web-1", tail=50))
    assert lines == ["line one", "line two"]
    # --follow is the whole point; tail is clamped and passed through.
    assert "--follow" in captured["args"]
    assert captured["args"][captured["args"].index("--tail") + 1] == "50"


def test_stream_container_logs_rejects_bad_name(monkeypatch):
    monkeypatch.setattr(rt, "_podman_path", lambda: "/usr/bin/podman")
    with pytest.raises(rt.PodmanError):
        list(rt.stream_container_logs("--privileged"))


def test_logs_stream_endpoint_emits_sse(client, monkeypatch):
    monkeypatch.setattr(rt, "_podman_path", lambda: "/usr/bin/podman")
    monkeypatch.setattr(rt.subprocess, "Popen", lambda args, **kw: _FakePopen(args, **kw))

    with client.stream("GET", "/api/podman/containers/web-1/logs/stream") as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        body = "".join(r.iter_text())
    assert "data: line one" in body
    assert "data: line two" in body


def test_logs_stream_endpoint_surfaces_error_frame(client, monkeypatch):
    monkeypatch.setattr(rt, "_podman_path", lambda: None)  # podman not installed
    with client.stream("GET", "/api/podman/containers/web-1/logs/stream") as r:
        assert r.status_code == 200
        body = "".join(r.iter_text())
    assert "event: error" in body
    assert "not installed" in body
