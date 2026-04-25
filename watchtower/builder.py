"""
WatchTower Build Runner
Handles actual git clone → build → deploy pipeline for projects.
"""

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
import json as _json
from datetime import datetime
from pathlib import Path
from typing import Optional
from uuid import UUID

from sqlalchemy.orm import Session

from watchtower.database import (
    Build,
    BuildStatus,
    Deployment,
    DeploymentStatus,
    EnvironmentVariable,
    NetlifeLikeConfig,
    OrgNode,
    Project,
    SessionLocal,
    UseCaseType,
    VericelLikeConfig,
    DockerPlatformConfig,
)

logger = logging.getLogger(__name__)

# Directory under which all build workspaces live.
BUILD_BASE = Path(os.getenv("WATCHTOWER_BUILD_DIR", "/tmp/watchtower-builds"))
BUILD_BASE.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def run_build_sync(deployment_id: str) -> None:
    """Synchronous entry point — wraps the async runner for use from threads."""
    asyncio.run(_run_build(deployment_id))


async def run_build_async(deployment_id: str) -> None:
    """Async entry point — call from an asyncio context (e.g. FastAPI background)."""
    await _run_build(deployment_id)


# ---------------------------------------------------------------------------
# Internal pipeline
# ---------------------------------------------------------------------------


async def _run_build(deployment_id: str) -> None:
    db: Session = SessionLocal()
    workspace: Optional[Path] = None
    try:
        deployment = db.query(Deployment).filter(Deployment.id == deployment_id).first()
        if not deployment:
            logger.error("Build runner: deployment %s not found", deployment_id)
            return

        project: Project = deployment.project

        # Create / reset build record
        build = Build(
            deployment_id=deployment.id,
            build_command=_resolve_build_command(db, project),
            status=BuildStatus.RUNNING,
            started_at=datetime.utcnow(),
        )
        db.add(build)
        deployment.status = DeploymentStatus.BUILDING
        deployment.started_at = datetime.utcnow()
        db.commit()
        db.refresh(build)

        workspace = BUILD_BASE / str(deployment.id)
        workspace.mkdir(parents=True, exist_ok=True)

        log_lines: list[str] = []

        def _append(line: str) -> None:
            log_lines.append(line)
            # Write incrementally so WebSocket tail can pick it up
            build.build_output = "\n".join(log_lines)
            db.commit()

        _append(f"[WatchTower] Build started at {datetime.utcnow().isoformat()}")
        _append(f"[WatchTower] Project: {project.name}  |  Branch: {deployment.branch}")

        # ── Step 1: Clone / pull repo ──────────────────────────────────────
        repo_dir = workspace / "repo"
        ok, err = await _clone_repo(
            project.repo_url, deployment.branch, repo_dir, _append
        )
        if not ok:
            raise RuntimeError(f"Git clone failed: {err}")

        # ── Step 2: Resolve env vars ───────────────────────────────────────
        env_vars = _load_env_vars(db, project)

        # ── Step 3: Run build command ──────────────────────────────────────
        build_cmd = build.build_command
        if build_cmd:
            _append(f"\n[WatchTower] Running build: {build_cmd}")
            ok, err = await _run_cmd(build_cmd, cwd=repo_dir, env_vars=env_vars, append=_append)
            if not ok:
                raise RuntimeError(f"Build command failed: {err}")
        else:
            _append("[WatchTower] No build command — skipping build step.")

        # ── Step 4: Deploy to nodes ────────────────────────────────────────
        output_path = _resolve_output_path(db, project, repo_dir)
        nodes = _get_deployment_nodes(db, deployment)

        if nodes:
            deployment.status = DeploymentStatus.DEPLOYING
            db.commit()
            _append(f"\n[WatchTower] Deploying to {len(nodes)} node(s)…")
            for node in nodes:
                ok, err = await _rsync_to_node(node, output_path, _append)
                if not ok:
                    raise RuntimeError(f"Deploy to {node.host} failed: {err}")
                # Reload service on node
                if node.reload_command:
                    _append(f"[WatchTower] Reloading service on {node.host}…")
                    ok, err = await _ssh_run(node, node.reload_command, _append)
                    if not ok:
                        _append(f"[WatchTower] ⚠ Reload command failed: {err}")
        else:
            _append("[WatchTower] ⚠ No deployment nodes configured — build artifacts stored locally only.")

        # ── Step 5: Mark success ───────────────────────────────────────────
        _append(f"\n[WatchTower] ✅ Build complete at {datetime.utcnow().isoformat()}")
        build.status = BuildStatus.SUCCESS
        build.completed_at = datetime.utcnow()
        deployment.status = DeploymentStatus.LIVE
        deployment.completed_at = datetime.utcnow()
        db.commit()

        await _send_notifications(db, project, deployment, success=True)

    except Exception as exc:
        logger.exception("Build runner error for deployment %s", deployment_id)
        try:
            if build:
                build.build_output = (build.build_output or "") + f"\n[WatchTower] ❌ {exc}"
                build.status = BuildStatus.FAILED
                build.completed_at = datetime.utcnow()
            if deployment:
                deployment.status = DeploymentStatus.FAILED
                deployment.completed_at = datetime.utcnow()
            db.commit()
            await _send_notifications(db, project, deployment, success=False)
        except Exception:
            pass
    finally:
        db.close()
        # Clean up workspace to avoid disk fill-up
        if workspace and workspace.exists():
            try:
                shutil.rmtree(workspace)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _clone_repo(
    repo_url: str,
    branch: str,
    dest: Path,
    append,
) -> tuple[bool, str]:
    if dest.exists():
        shutil.rmtree(dest)
    append(f"[git] Cloning {repo_url} @ {branch}…")
    proc = await asyncio.create_subprocess_exec(
        "git", "clone", "--depth=1", "--branch", branch, repo_url, str(dest),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    output = stdout.decode(errors="replace").strip()
    if output:
        for line in output.splitlines():
            append(f"[git] {line}")
    if proc.returncode != 0:
        return False, output
    return True, ""


async def _run_cmd(
    cmd: str,
    cwd: Path,
    env_vars: dict,
    append,
    timeout: int = 600,
) -> tuple[bool, str]:
    env = {**os.environ, **env_vars}
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            cwd=str(cwd),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return False, f"Build timed out after {timeout}s"
        output = stdout.decode(errors="replace").strip()
        for line in output.splitlines():
            append(line)
        if proc.returncode != 0:
            return False, f"exit code {proc.returncode}"
        return True, ""
    except Exception as exc:
        return False, str(exc)


async def _rsync_to_node(node: OrgNode, src: Path, append) -> tuple[bool, str]:
    dest = f"{node.user}@{node.host}:{node.remote_path}/"
    ssh_opts = f"-p {node.port}"
    if node.ssh_key_path:
        ssh_opts += f" -i {node.ssh_key_path}"
    cmd = [
        "rsync", "-az", "--delete",
        "-e", f"ssh -o StrictHostKeyChecking=accept-new {ssh_opts}",
        f"{src}/", dest,
    ]
    append(f"[rsync] → {dest}")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    output = stdout.decode(errors="replace").strip()
    for line in output.splitlines():
        append(f"[rsync] {line}")
    if proc.returncode != 0:
        return False, output
    return True, ""


async def _ssh_run(node: OrgNode, command: str, append) -> tuple[bool, str]:
    ssh_opts = ["-p", str(node.port), "-o", "StrictHostKeyChecking=accept-new"]
    if node.ssh_key_path:
        ssh_opts += ["-i", node.ssh_key_path]
    cmd = ["ssh"] + ssh_opts + [f"{node.user}@{node.host}", command]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    stdout, _ = await proc.communicate()
    output = stdout.decode(errors="replace").strip()
    for line in output.splitlines():
        append(f"[ssh] {line}")
    if proc.returncode != 0:
        return False, output
    return True, ""


def _resolve_build_command(db: Session, project: Project) -> str:
    if project.use_case == UseCaseType.NETLIFY_LIKE:
        cfg = db.query(NetlifeLikeConfig).filter_by(project_id=project.id).first()
        return "npm ci && npm run build" if cfg else "npm ci && npm run build"
    if project.use_case == UseCaseType.VERCEL_LIKE:
        cfg = db.query(VericelLikeConfig).filter_by(project_id=project.id).first()
        return "npm ci && npm run build" if cfg else "npm ci && npm run build"
    if project.use_case == UseCaseType.DOCKER_PLATFORM:
        cfg = db.query(DockerPlatformConfig).filter_by(project_id=project.id).first()
        if cfg:
            return f"docker build -t watchtower-{project.id} -f {cfg.dockerfile_path} ."
        return "docker build -t watchtower-app ."
    return ""


def _resolve_output_path(db: Session, project: Project, repo_dir: Path) -> Path:
    if project.use_case == UseCaseType.NETLIFY_LIKE:
        cfg = db.query(NetlifeLikeConfig).filter_by(project_id=project.id).first()
        out_dir = cfg.output_dir if cfg else "dist"
        return repo_dir / out_dir
    if project.use_case == UseCaseType.VERCEL_LIKE:
        return repo_dir / ".next"
    # Docker: deploy whole repo
    return repo_dir


def _load_env_vars(db: Session, project: Project) -> dict:
    rows = db.query(EnvironmentVariable).filter_by(project_id=project.id).all()
    return {r.key: r.value for r in rows}


def _get_deployment_nodes(db: Session, deployment: Deployment) -> list:
    from watchtower.database import DeploymentNode
    dn_rows = db.query(DeploymentNode).filter_by(deployment_id=deployment.id).all()
    if not dn_rows:
        return []
    node_ids = [dn.node_id for dn in dn_rows]
    return db.query(OrgNode).filter(OrgNode.id.in_(node_ids), OrgNode.is_active == True).all()


# ---------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------


async def _send_notifications(
    db: Session,
    project: Project,
    deployment: Deployment,
    success: bool,
) -> None:
    """Fire-and-forget notification webhooks (Discord + Slack)."""
    from watchtower.database import NotificationWebhook  # imported lazily
    try:
        hooks = db.query(NotificationWebhook).filter_by(
            project_id=project.id, is_active=True
        ).all()
    except Exception:
        return  # table may not exist yet

    if not hooks:
        return

    status_text = "✅ Deployment succeeded" if success else "❌ Deployment failed"
    message = (
        f"{status_text}\n"
        f"**Project:** {project.name}\n"
        f"**Branch:** {deployment.branch}  |  `{deployment.commit_sha[:8]}`"
    )

    for hook in hooks:
        try:
            payload: dict
            if hook.provider == "slack":
                payload = {"text": message.replace("**", "*")}
            else:  # discord
                payload = {"content": message}
            data = _json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                hook.url,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=10):
                pass
        except Exception as exc:
            logger.warning("Notification webhook failed (%s): %s", hook.url[:40], exc)


# ---------------------------------------------------------------------------
# SSH health check (used by node management)
# ---------------------------------------------------------------------------


def check_ssh_connectivity(node: OrgNode) -> tuple[bool, str]:
    """
    Try an SSH connection to the node and run `echo ok`.
    Returns (success, message).
    """
    ssh_opts = ["-p", str(node.port), "-o", "StrictHostKeyChecking=accept-new",
                "-o", "ConnectTimeout=5", "-o", "BatchMode=yes"]
    if node.ssh_key_path:
        ssh_opts += ["-i", node.ssh_key_path]
    cmd = ["ssh"] + ssh_opts + [f"{node.user}@{node.host}", "echo ok"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode == 0 and "ok" in result.stdout:
            return True, "SSH connection successful"
        return False, (result.stderr or result.stdout or "SSH failed").strip()
    except subprocess.TimeoutExpired:
        return False, "SSH connection timed out"
    except Exception as exc:
        return False, str(exc)


# ---------------------------------------------------------------------------
# Framework detection
# ---------------------------------------------------------------------------


def detect_framework(repo_url: str, branch: str = "main") -> dict:
    """
    Detect framework by fetching package.json from the repo's default branch
    via GitHub raw content URL (no clone required for public repos).
    Falls back to cloning a shallow copy when direct fetch fails.
    """
    framework = "unknown"
    build_command = "npm ci && npm run build"
    output_dir = "dist"
    detected = False

    # Try GitHub raw URL (works for public repos without a token)
    if "github.com" in repo_url:
        raw = _gh_raw_package_json(repo_url, branch)
        if raw:
            framework, build_command, output_dir = _parse_package_json(raw)
            detected = True

    if not detected:
        # Shallow clone to a temp dir
        with tempfile.TemporaryDirectory() as tmp:
            try:
                subprocess.run(
                    ["git", "clone", "--depth=1", "--branch", branch, repo_url, tmp],
                    capture_output=True, timeout=30, check=True,
                )
                pkg = Path(tmp) / "package.json"
                if pkg.exists():
                    raw = _json.loads(pkg.read_text())
                    framework, build_command, output_dir = _parse_package_json(raw)
                    detected = True
            except Exception:
                pass

    return {
        "framework": framework,
        "detected": detected,
        "build_command": build_command,
        "output_dir": output_dir,
    }


def _gh_raw_package_json(repo_url: str, branch: str) -> Optional[dict]:
    """Fetch package.json from a GitHub repo via raw content API."""
    # Normalise: https://github.com/owner/repo(.git)? → owner/repo
    url = repo_url.rstrip("/").removesuffix(".git")
    parts = url.split("github.com/", 1)
    if len(parts) < 2:
        return None
    path = parts[1].strip("/")
    raw_url = f"https://raw.githubusercontent.com/{path}/{branch}/package.json"
    try:
        req = urllib.request.Request(raw_url, headers={"User-Agent": "WatchTower/2.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            return _json.loads(resp.read())
    except Exception:
        return None


def _parse_package_json(pkg: dict) -> tuple[str, str, str]:
    """Return (framework, build_command, output_dir) from package.json."""
    deps = {
        **pkg.get("dependencies", {}),
        **pkg.get("devDependencies", {}),
    }
    scripts = pkg.get("scripts", {})
    build_cmd = scripts.get("build", "npm ci && npm run build")
    if "npm ci" not in build_cmd:
        build_cmd = f"npm ci && {build_cmd}"

    # Framework detection by known deps
    if "next" in deps:
        return "next.js", build_cmd, ".next"
    if "nuxt" in deps or "@nuxt/core" in deps:
        return "nuxt", build_cmd, ".nuxt"
    if "@sveltejs/kit" in deps:
        return "sveltekit", build_cmd, "build"
    if "astro" in deps:
        return "astro", build_cmd, "dist"
    if "gatsby" in deps:
        return "gatsby", build_cmd, "public"
    if "vite" in deps:
        return "vite", build_cmd, "dist"
    if "react-scripts" in deps:
        return "create-react-app", build_cmd, "build"
    if "@angular/core" in deps:
        return "angular", build_cmd, "dist"
    if "vue" in deps:
        return "vue", build_cmd, "dist"

    return "node.js", build_cmd, "dist"
