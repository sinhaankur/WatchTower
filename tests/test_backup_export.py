"""Coverage for the credential-set backup endpoint.

Tests the happy path (tar.gz contains expected files), authorisation
gate (403 without can_manage_team), and the empty-state shortcut
(404 when nothing has been created yet).

The static API-token test client (TestClient with Bearer test-token)
goes through the static-token auth path. That path needs to land in
the canonical org with can_manage_team=True for these tests to pass —
the bootstrap flow in enterprise._ensure_user_org_member promotes the
first user to OWNER, which the test fixtures exercise once a project
is created. So we create a project first to ensure org membership
exists.
"""

from __future__ import annotations

import io
import tarfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient


def _create_project_to_bootstrap_org(client: TestClient) -> None:
    """Force the bootstrap path so the test user gets OWNER + can_manage_team.

    Without this, the static-token user has no TeamMember row and the
    backup gate (which requires can_manage_team=True) returns 403 even
    on a fresh test DB.
    """
    r = client.post(
        "/api/projects",
        json={
            "name": "backup-bootstrap",
            "use_case": "vercel_like",
            "repo_url": "https://example.com/x.git",
            "repo_branch": "main",
        },
    )
    assert r.status_code == 201, r.text


def test_backup_status_reports_supported_for_sqlite(client: TestClient, tmp_path: Path):
    _create_project_to_bootstrap_org(client)
    with patch.dict("os.environ", {"WATCHTOWER_DATA_DIR": str(tmp_path)}, clear=False):
        r = client.get("/api/runtime/backup/status")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["supported"] is True
    assert body["reason_unsupported"] is None
    assert body["can_export"] is True


def test_backup_export_returns_tarball_with_expected_files(
    client: TestClient, tmp_path: Path
):
    """Happy path. The endpoint reads from the on-disk SQLite file
    pointed at by DATABASE_URL plus secret.key in WATCHTOWER_DATA_DIR;
    we point both at tmp_path-staged files so the test doesn't depend
    on the dev clone's real ~/.watchtower/.
    """
    _create_project_to_bootstrap_org(client)

    # Stage a fake secret.key + a copy of the SQLite DB at tmp_path so
    # the endpoint's resolver finds them. The real DB lives wherever
    # the test conftest set it; we patch _resolve_data_dir directly so
    # the secret.key lookup hits our stub.
    fake_data_dir = tmp_path / "watchtower-test-data"
    fake_data_dir.mkdir()
    (fake_data_dir / "secret.key").write_text("fake-fernet-key-32-bytes-long-x")

    with patch(
        "watchtower.api.runtime._resolve_data_dir", return_value=fake_data_dir
    ):
        r = client.get("/api/runtime/backup/export")

    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/gzip")
    disposition = r.headers["content-disposition"]
    assert "attachment" in disposition
    assert "watchtower-backup-" in disposition
    assert disposition.endswith('.tar.gz"')
    assert r.headers.get("cache-control") == "no-store"

    # Inspect the tarball — secret.key must be in there. The DB file
    # is included if the test fixture's DATABASE_URL points at a
    # SQLite file that exists at probe time, which in this test setup
    # is true.
    buf = io.BytesIO(r.content)
    with tarfile.open(fileobj=buf, mode="r:gz") as tar:
        names = tar.getnames()
    assert "secret.key" in names


def test_backup_export_returns_404_when_nothing_to_back_up(
    client: TestClient, tmp_path: Path
):
    """Fresh install with no DB file and no secret.key — endpoint
    should return a clear 404 explaining that there's nothing to back
    up yet."""
    _create_project_to_bootstrap_org(client)
    empty_dir = tmp_path / "empty"
    empty_dir.mkdir()

    with patch(
        "watchtower.api.runtime._resolve_data_dir", return_value=empty_dir
    ), patch(
        "watchtower.api.runtime._resolve_sqlite_db_path",
        return_value=empty_dir / "nonexistent.db",
    ):
        r = client.get("/api/runtime/backup/export")
    assert r.status_code == 404
    detail = r.json().get("detail", "").lower()
    assert "fresh install" in detail or "nothing to back up" in detail


def test_backup_export_returns_503_for_postgres_install(
    client: TestClient, tmp_path: Path
):
    """Postgres install — backup needs pg_dump, not in v1 scope. The
    endpoint should explain why and not silently produce an
    inconsistent tarball."""
    _create_project_to_bootstrap_org(client)

    with patch(
        "watchtower.api.runtime._resolve_sqlite_db_path", return_value=None
    ):
        r = client.get("/api/runtime/backup/export")
    assert r.status_code == 503
    assert "pg_dump" in r.json()["detail"]


def test_backup_export_requires_auth(anon_client: TestClient):
    r = anon_client.get("/api/runtime/backup/export")
    assert r.status_code == 401


def test_backup_status_requires_auth(anon_client: TestClient):
    r = anon_client.get("/api/runtime/backup/status")
    assert r.status_code == 401
