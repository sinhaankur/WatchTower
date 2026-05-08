"""
Unit tests for watchtower/builder.py

Covers the pure-logic helpers and the async pipeline with subprocesses
mocked out so no real git/rsync/ssh calls happen.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch, call
import pytest

# conftest.py already set the env vars and called init_db(); just import.
from watchtower import builder
from watchtower.builder import (
    _redact_url,
    _resolve_build_command,
    _resolve_output_path,
    _load_env_vars,
    _parse_package_json,
    run_build_sync,
)
from watchtower.database import (
    Build,
    BuildStatus,
    Deployment,
    DeploymentStatus,
    DeploymentTrigger,
    DockerPlatformConfig,
    EnvironmentVariable,
    Environment,
    NetlifeLikeConfig,
    Organization,
    Project,
    SessionLocal,
    UseCaseType,
    VericelLikeConfig,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def db():
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture()
def org(db):
    o = Organization(id=uuid.uuid4(), name="test-org")
    db.add(o)
    db.commit()
    db.refresh(o)
    return o


@pytest.fixture()
def project(db, org):
    p = Project(
        id=uuid.uuid4(),
        name="test-project",
        use_case=UseCaseType.NETLIFY_LIKE,
        repo_url="https://github.com/example/repo",
        repo_branch="main",
        webhook_secret="secret",
        org_id=org.id,
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@pytest.fixture()
def deployment(db, project):
    d = Deployment(
        id=uuid.uuid4(),
        project_id=project.id,
        commit_sha="abc1234",
        branch="main",
        status=DeploymentStatus.PENDING,
        trigger=DeploymentTrigger.MANUAL,
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


# ---------------------------------------------------------------------------
# _redact_url
# ---------------------------------------------------------------------------


class TestRedactUrl:
    def test_strips_token_from_https_url(self):
        url = "https://x-access-token:ghp_SECRET@github.com/owner/repo.git"
        result = _redact_url(url)
        assert "ghp_SECRET" not in result
        assert "***@github.com" in result

    def test_passthrough_for_url_without_credentials(self):
        url = "https://github.com/owner/repo.git"
        assert _redact_url(url) == url

    def test_redacts_user_password_pair(self):
        url = "https://user:password@host.example.com/path"
        result = _redact_url(url)
        assert "password" not in result
        assert "***@host.example.com" in result

    def test_non_url_text_is_unchanged(self):
        text = "some log line without any URL"
        assert _redact_url(text) == text


# ---------------------------------------------------------------------------
# _resolve_build_command
# ---------------------------------------------------------------------------


class TestResolveBuildCommand:
    def test_netlify_without_config(self, db, project):
        project.use_case = UseCaseType.NETLIFY_LIKE
        db.commit()
        cmd = _resolve_build_command(db, project)
        assert "npm" in cmd

    def test_netlify_with_config(self, db, project):
        project.use_case = UseCaseType.NETLIFY_LIKE
        db.add(NetlifeLikeConfig(project_id=project.id, output_dir="build"))
        db.commit()
        cmd = _resolve_build_command(db, project)
        assert "npm" in cmd

    def test_vercel(self, db, project):
        project.use_case = UseCaseType.VERCEL_LIKE
        db.commit()
        cmd = _resolve_build_command(db, project)
        assert "npm" in cmd

    def test_docker_without_config(self, db, project):
        project.use_case = UseCaseType.DOCKER_PLATFORM
        db.commit()
        cmd = _resolve_build_command(db, project)
        assert "docker build" in cmd

    def test_docker_with_config(self, db, project):
        project.use_case = UseCaseType.DOCKER_PLATFORM
        cfg = DockerPlatformConfig(
            project_id=project.id,
            dockerfile_path="./Dockerfile.prod",
            exposed_port=8080,
            target_nodes="node1",
        )
        db.add(cfg)
        db.commit()
        cmd = _resolve_build_command(db, project)
        assert "Dockerfile.prod" in cmd


# ---------------------------------------------------------------------------
# _resolve_output_path
# ---------------------------------------------------------------------------


class TestResolveOutputPath:
    def test_netlify_uses_output_dir(self, db, project, tmp_path):
        project.use_case = UseCaseType.NETLIFY_LIKE
        cfg = NetlifeLikeConfig(project_id=project.id, output_dir="public")
        db.add(cfg)
        db.commit()
        result = _resolve_output_path(db, project, tmp_path)
        assert result == tmp_path / "public"

    def test_netlify_defaults_to_dist(self, db, project, tmp_path):
        project.use_case = UseCaseType.NETLIFY_LIKE
        db.commit()
        result = _resolve_output_path(db, project, tmp_path)
        assert result == tmp_path / "dist"

    def test_vercel_uses_next(self, db, project, tmp_path):
        project.use_case = UseCaseType.VERCEL_LIKE
        db.commit()
        result = _resolve_output_path(db, project, tmp_path)
        assert result == tmp_path / ".next"

    def test_docker_returns_repo_dir(self, db, project, tmp_path):
        project.use_case = UseCaseType.DOCKER_PLATFORM
        db.commit()
        result = _resolve_output_path(db, project, tmp_path)
        assert result == tmp_path


# ---------------------------------------------------------------------------
# _load_env_vars
# ---------------------------------------------------------------------------


class TestLoadEnvVars:
    def test_returns_empty_dict_when_no_vars(self, db, project):
        result = _load_env_vars(db, project)
        assert result == {}

    def test_returns_key_value_pairs(self, db, project):
        db.add(EnvironmentVariable(
            project_id=project.id,
            key="API_KEY",
            value="my-secret-value",
            environment=Environment.PRODUCTION,
        ))
        db.add(EnvironmentVariable(
            project_id=project.id,
            key="DEBUG",
            value="false",
            environment=Environment.PRODUCTION,
        ))
        db.commit()
        result = _load_env_vars(db, project)
        assert result["API_KEY"] == "my-secret-value"
        assert result["DEBUG"] == "false"

    def test_returns_all_environments(self, db, project):
        db.add(EnvironmentVariable(
            project_id=project.id,
            key="PROD_ONLY",
            value="prod",
            environment=Environment.PRODUCTION,
        ))
        db.add(EnvironmentVariable(
            project_id=project.id,
            key="DEV_ONLY",
            value="dev",
            environment=Environment.DEVELOPMENT,
        ))
        db.commit()
        result = _load_env_vars(db, project)
        assert "PROD_ONLY" in result
        assert "DEV_ONLY" in result


# ---------------------------------------------------------------------------
# _parse_package_json
# ---------------------------------------------------------------------------


class TestParsePackageJson:
    def test_detects_next(self):
        pkg = {"dependencies": {"next": "^14.0.0"}}
        framework, cmd, out_dir = _parse_package_json(pkg)
        assert framework == "next.js"
        assert ".next" in out_dir or "next" in cmd.lower()

    def test_detects_vue(self):
        pkg = {"dependencies": {"vue": "^3.0.0"}}
        framework, cmd, out_dir = _parse_package_json(pkg)
        assert framework == "vue"

    def test_detects_react_via_deps(self):
        pkg = {
            "dependencies": {"react-scripts": "^5.0.0"},
            "scripts": {"build": "react-scripts build"},
        }
        framework, cmd, out_dir = _parse_package_json(pkg)
        assert framework == "create-react-app"

    def test_uses_custom_build_script(self):
        pkg = {
            "scripts": {"build": "tsc && node esbuild.js"},
        }
        framework, cmd, out_dir = _parse_package_json(pkg)
        assert "tsc" in cmd or "npm" in cmd

    def test_handles_empty_package_json(self):
        framework, cmd, out_dir = _parse_package_json({})
        assert isinstance(framework, str)
        assert isinstance(cmd, str)
        assert isinstance(out_dir, str)


# ---------------------------------------------------------------------------
# run_build_sync — invalid deployment ID
# ---------------------------------------------------------------------------


class TestRunBuildSync:
    def test_malformed_deployment_id_returns_silently(self):
        """A non-UUID deployment_id should log an error and return, not raise."""
        # Should not raise; the function logs and returns.
        run_build_sync("not-a-uuid")

    def test_missing_deployment_id_returns_silently(self):
        """A valid UUID for a non-existent deployment should return without raising."""
        run_build_sync(str(uuid.uuid4()))


# ---------------------------------------------------------------------------
# _run_build — full pipeline with mocked subprocesses
# ---------------------------------------------------------------------------


class TestRunBuildPipeline:
    """Test the async pipeline end-to-end using a real in-memory DB row but
    mocking out git/rsync/ssh so no network or filesystem access is needed."""

    def _make_completed_proc(self, returncode: int = 0, stdout: bytes = b"ok\n"):
        # The builder now streams subprocess output via proc.stdout.read()
        # + proc.wait(), so the mock has to model both. proc.stdout.read(n)
        # yields the canned bytes once then b"" forever (EOF).
        proc = AsyncMock()
        proc.returncode = returncode
        stdout_reader = AsyncMock()
        pending = [stdout]

        async def _read(_n: int = -1) -> bytes:
            return pending.pop(0) if pending else b""

        stdout_reader.read = _read
        proc.stdout = stdout_reader
        proc.wait = AsyncMock(return_value=returncode)
        proc.communicate = AsyncMock(return_value=(stdout, b""))
        return proc

    @patch("watchtower.builder.asyncio.create_subprocess_exec")
    def test_successful_build_marks_deployment_live(self, mock_exec, deployment):
        mock_exec.return_value = self._make_completed_proc()

        with patch("watchtower.builder.asyncio.create_subprocess_shell") as mock_shell:
            mock_shell.return_value = self._make_completed_proc()
            run_build_sync(str(deployment.id))

        db = SessionLocal()
        try:
            d = db.query(Deployment).filter(Deployment.id == deployment.id).first()
            b = db.query(Build).filter(Build.deployment_id == deployment.id).first()
            assert d.status == DeploymentStatus.LIVE
            assert b.status == BuildStatus.SUCCESS
        finally:
            db.close()

    @patch("watchtower.builder.asyncio.create_subprocess_exec")
    def test_git_clone_failure_marks_deployment_failed(self, mock_exec, deployment):
        # git clone exits non-zero
        mock_exec.return_value = self._make_completed_proc(returncode=1, stdout=b"fatal: repo not found\n")

        run_build_sync(str(deployment.id))

        db = SessionLocal()
        try:
            d = db.query(Deployment).filter(Deployment.id == deployment.id).first()
            b = db.query(Build).filter(Build.deployment_id == deployment.id).first()
            assert d.status == DeploymentStatus.FAILED
            assert b.status == BuildStatus.FAILED
            assert "fatal" in (b.build_output or "").lower() or "failed" in (b.build_output or "").lower()
        finally:
            db.close()

    @patch("watchtower.builder.asyncio.create_subprocess_exec")
    @patch("watchtower.builder.asyncio.create_subprocess_shell")
    def test_build_command_failure_marks_deployment_failed(self, mock_shell, mock_exec, deployment):
        # git clone succeeds, build command fails
        mock_exec.return_value = self._make_completed_proc()
        mock_shell.return_value = self._make_completed_proc(returncode=1, stdout=b"npm ERR! missing script\n")

        run_build_sync(str(deployment.id))

        db = SessionLocal()
        try:
            d = db.query(Deployment).filter(Deployment.id == deployment.id).first()
            assert d.status == DeploymentStatus.FAILED
        finally:
            db.close()
