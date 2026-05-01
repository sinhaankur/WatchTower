"""Coverage for the on-demand health-check endpoint.

Foundation for gap #2 (health checks + auto-rollback). v1 ships
on-demand probes only; this test pins the response shape so the
v2 background poller can reuse it.
"""

from __future__ import annotations

from unittest.mock import patch, MagicMock

import requests
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from watchtower.database import Project as ProjectModel


def _create_project(client: TestClient, name: str = "health-check-test") -> dict:
    r = client.post(
        "/api/projects",
        json={
            "name": name,
            "use_case": "vercel_like",
            "repo_url": "https://example.com/x.git",
            "repo_branch": "main",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def _set_launch_url(db: Session, project_id: str, url: str | None) -> None:
    """Directly set Project.launch_url since the API surface doesn't
    expose it as a writable field (it's set by the builder pipeline).
    """
    from uuid import UUID
    proj = db.query(ProjectModel).filter(ProjectModel.id == UUID(project_id)).first()
    assert proj is not None
    proj.launch_url = url
    db.commit()


def test_health_check_returns_no_url_when_project_not_deployed(
    client: TestClient, db_session: Session
):
    project = _create_project(client, name="no-url-yet")
    # launch_url is null by default for fresh projects.

    r = client.get(f"/api/projects/{project['id']}/health-check")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "no_url"
    assert body["response_code"] is None
    assert body["url"] is None
    assert "deploy" in (body["error"] or "").lower()


def test_health_check_reports_healthy_on_2xx(client: TestClient, db_session: Session):
    project = _create_project(client, name="healthy-probe")
    _set_launch_url(db_session, project["id"], "http://127.0.0.1:9999")

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.raw.read.return_value = b""

    with patch("requests.get", return_value=mock_response):
        r = client.get(f"/api/projects/{project['id']}/health-check")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "healthy"
    assert body["response_code"] == 200
    assert body["url"] == "http://127.0.0.1:9999/health"
    assert body["latency_ms"] is not None and body["latency_ms"] >= 0


def test_health_check_reports_healthy_on_404(client: TestClient, db_session: Session):
    """404 on /health is treated as 'healthy' — anything < 500 means
    the service is up and responding, even if the specific path
    isn't configured. Up-and-misconfigured is a different (loud) UX
    than down."""
    project = _create_project(client, name="404-probe")
    _set_launch_url(db_session, project["id"], "http://127.0.0.1:9998")

    mock_response = MagicMock()
    mock_response.status_code = 404
    mock_response.raw.read.return_value = b""

    with patch("requests.get", return_value=mock_response):
        r = client.get(f"/api/projects/{project['id']}/health-check")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "healthy"
    assert body["response_code"] == 404


def test_health_check_reports_unhealthy_on_5xx(client: TestClient, db_session: Session):
    project = _create_project(client, name="5xx-probe")
    _set_launch_url(db_session, project["id"], "http://127.0.0.1:9997")

    mock_response = MagicMock()
    mock_response.status_code = 503
    mock_response.raw.read.return_value = b""

    with patch("requests.get", return_value=mock_response):
        r = client.get(f"/api/projects/{project['id']}/health-check")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "unhealthy"
    assert body["response_code"] == 503


def test_health_check_reports_unreachable_on_connection_error(
    client: TestClient, db_session: Session
):
    project = _create_project(client, name="unreachable-probe")
    _set_launch_url(db_session, project["id"], "http://127.0.0.1:9996")

    with patch("requests.get", side_effect=requests.ConnectionError("connection refused")):
        r = client.get(f"/api/projects/{project['id']}/health-check")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "unreachable"
    assert body["response_code"] is None
    assert "connection refused" in (body["error"] or "").lower()


def test_health_check_reports_unreachable_on_timeout(
    client: TestClient, db_session: Session
):
    project = _create_project(client, name="timeout-probe")
    _set_launch_url(db_session, project["id"], "http://127.0.0.1:9995")

    with patch("requests.get", side_effect=requests.Timeout("read timeout")):
        r = client.get(f"/api/projects/{project['id']}/health-check")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "unreachable"
    assert "timeout" in (body["error"] or "").lower()


def test_health_check_supports_custom_path(client: TestClient, db_session: Session):
    project = _create_project(client, name="custom-path-probe")
    _set_launch_url(db_session, project["id"], "http://127.0.0.1:9994")

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.raw.read.return_value = b""

    with patch("requests.get", return_value=mock_response) as mock_get:
        r = client.get(
            f"/api/projects/{project['id']}/health-check?path=/api/v1/healthz"
        )

    assert r.status_code == 200
    assert r.json()["url"] == "http://127.0.0.1:9994/api/v1/healthz"
    # Confirm the path actually flowed through to the upstream call.
    assert mock_get.call_args.args[0] == "http://127.0.0.1:9994/api/v1/healthz"


def test_health_check_rejects_path_without_leading_slash(
    client: TestClient, db_session: Session
):
    """Validation rule pinned: paths must start with / so a malicious
    "http://attacker.com/" can't override the host."""
    project = _create_project(client, name="bad-path-probe")
    _set_launch_url(db_session, project["id"], "http://127.0.0.1:9993")

    r = client.get(
        f"/api/projects/{project['id']}/health-check?path=http://attacker.com/"
    )
    assert r.status_code == 400
    assert "must start with" in r.json()["detail"]


def test_health_check_caps_timeout_to_15_seconds(client: TestClient, db_session: Session):
    """A user-supplied 999s timeout is capped to 15s — protects
    against a malicious upstream tying up a worker thread."""
    project = _create_project(client, name="timeout-cap-probe")
    _set_launch_url(db_session, project["id"], "http://127.0.0.1:9992")

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.raw.read.return_value = b""

    with patch("requests.get", return_value=mock_response) as mock_get:
        r = client.get(
            f"/api/projects/{project['id']}/health-check?timeout_seconds=999"
        )

    assert r.status_code == 200
    # Timeout kwarg passed to requests.get should be ≤ 15.
    assert mock_get.call_args.kwargs["timeout"] == 15


def test_health_check_does_not_follow_redirects(client: TestClient, db_session: Session):
    """A 301 from /health → /login would otherwise report 'healthy'
    when the actual health endpoint is broken. We pin allow_redirects=False
    so the user sees the real status."""
    project = _create_project(client, name="no-redirect-probe")
    _set_launch_url(db_session, project["id"], "http://127.0.0.1:9991")

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.raw.read.return_value = b""

    with patch("requests.get", return_value=mock_response) as mock_get:
        r = client.get(f"/api/projects/{project['id']}/health-check")

    assert r.status_code == 200
    assert mock_get.call_args.kwargs["allow_redirects"] is False


def test_health_check_returns_404_for_unknown_project(client: TestClient):
    bogus = "00000000-0000-0000-0000-000000000000"
    r = client.get(f"/api/projects/{bogus}/health-check")
    assert r.status_code == 404


def test_health_check_requires_auth(anon_client: TestClient):
    bogus = "00000000-0000-0000-0000-000000000000"
    r = anon_client.get(f"/api/projects/{bogus}/health-check")
    assert r.status_code == 401
