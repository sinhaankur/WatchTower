"""
WatchTower Build Runner
Handles actual git clone → build → deploy pipeline for projects.
"""
from watchtower.api.util import utcnow

import asyncio
import logging
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit, urlunsplit
import json as _json
from datetime import datetime
from pathlib import Path
from typing import Awaitable, Callable, Optional
from uuid import UUID

try:
    import fcntl  # POSIX file locks for per-project workspace mutex
    _HAS_FCNTL = True
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None  # type: ignore
    _HAS_FCNTL = False

from sqlalchemy.orm import Session

from watchtower.database import (
    Build,
    BuildStatus,
    Deployment,
    DeploymentStatus,
    EnvironmentVariable,
    GitHubConnection,
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

# Persistent per-project workspaces and package-manager caches live under
# stable subtrees of BUILD_BASE so they survive across deploys. The cache
# directory is shared across all builds of a given project — npm/pnpm/etc
# all handle concurrent reads on their cache directories internally.
_WORKSPACES_DIR = BUILD_BASE / "workspaces"
_CACHES_DIR = BUILD_BASE / "caches"
_LOCKS_DIR = BUILD_BASE / "locks"
for _d in (_WORKSPACES_DIR, _CACHES_DIR, _LOCKS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# Log-flush tuning. Every line gets queued in memory; we only commit the
# joined `build.build_output` to the DB once we've accumulated this many
# lines OR this much wall-clock time has elapsed since the last flush —
# whichever comes first. Keeps the WebSocket tail responsive while removing
# the per-line db.commit() that used to dominate build CPU on long logs.
_LOG_FLUSH_LINES = 25
_LOG_FLUSH_INTERVAL_SECS = 0.5


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
# Log writer — batched DB commits
# ---------------------------------------------------------------------------


class _LogWriter:
    """Buffered build-log writer.

    Collects lines in memory and commits the joined ``build.build_output``
    to the DB at most every ``_LOG_FLUSH_LINES`` lines or every
    ``_LOG_FLUSH_INTERVAL_SECS`` seconds. The previous implementation
    committed once per line, which on a 5,000-line build did 5,000
    commits and rebuilt the entire output string each time (quadratic).
    """

    __slots__ = ("db", "build", "lines", "_last_flush", "_pending")

    def __init__(self, db: Session, build: Build) -> None:
        self.db = db
        self.build = build
        self.lines: list[str] = []
        self._last_flush = time.monotonic()
        self._pending = 0

    def write(self, line: str) -> None:
        self.lines.append(line)
        self._pending += 1
        if (
            self._pending >= _LOG_FLUSH_LINES
            or (time.monotonic() - self._last_flush) >= _LOG_FLUSH_INTERVAL_SECS
        ):
            self.flush()

    def flush(self) -> None:
        if not self._pending:
            # Even with no new lines, callers may invoke flush() at status
            # transitions — re-joining is fine but skipping the commit when
            # nothing changed is the cheap path.
            return
        try:
            self.build.build_output = "\n".join(self.lines)
            self.db.commit()
        except Exception:
            # Don't let a transient DB hiccup kill the build.
            logger.exception("Build log flush failed; continuing")
        finally:
            self._last_flush = time.monotonic()
            self._pending = 0


# ---------------------------------------------------------------------------
# Subprocess streaming
# ---------------------------------------------------------------------------


async def _stream_proc(
    proc: asyncio.subprocess.Process,
    append: Callable[[str], None],
    prefix: str = "",
) -> int:
    """Read ``proc.stdout`` chunked, splitting on newlines, calling
    ``append`` for each completed line. Returns the process exit code.

    Replaces the old ``proc.communicate()`` pattern, which buffered the
    entire output before yielding any line — meaning the WebSocket "live
    tail" never showed anything until the build finished. We read raw
    chunks (rather than ``readline()``) so that pathological output with
    a >64KB single line doesn't trip asyncio's StreamReader limit.
    """
    if proc.stdout is None:
        return await proc.wait()
    buf = b""
    while True:
        chunk = await proc.stdout.read(4096)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line_b, buf = buf.split(b"\n", 1)
            line = line_b.decode(errors="replace").rstrip("\r")
            append(f"{prefix}{line}" if prefix else line)
    if buf:
        line = buf.decode(errors="replace").rstrip("\r")
        append(f"{prefix}{line}" if prefix else line)
    return await proc.wait()


# ---------------------------------------------------------------------------
# Workspace + cache management
# ---------------------------------------------------------------------------


def _acquire_workspace_lock(project_id) -> Optional[object]:
    """Try to grab an exclusive non-blocking flock on the per-project lock
    file. Returns the open file handle on success (caller releases by
    closing it) or ``None`` if another build of the same project already
    holds the lock — in which case the caller should fall back to a
    per-deploy ephemeral workspace.

    Returns ``None`` on platforms without ``fcntl`` (Windows) so we
    transparently fall back to per-deploy workspaces there.
    """
    if not _HAS_FCNTL:
        return None
    lock_path = _LOCKS_DIR / f"{project_id}.lock"
    try:
        fh = open(lock_path, "w")
    except OSError:
        return None
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)  # type: ignore[union-attr]
        return fh
    except (BlockingIOError, OSError):
        fh.close()
        return None


def _release_workspace_lock(fh: Optional[object]) -> None:
    if fh is None:
        return
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)  # type: ignore[union-attr,attr-defined]
    except Exception:
        pass
    try:
        fh.close()  # type: ignore[attr-defined]
    except Exception:
        pass


def _pkg_cache_env(project_id) -> dict[str, str]:
    """Per-project cache directories for the JS package managers we
    support. Setting these env vars (rather than a global $HOME-wide
    cache) keeps projects isolated — a cache poisoning issue in one
    project can't leak into another — while still avoiding the network
    round-trip on the second-and-subsequent builds.
    """
    base = _CACHES_DIR / str(project_id)
    npm = base / "npm"
    pnpm = base / "pnpm-store"
    yarn = base / "yarn"
    bun = base / "bun"
    for d in (npm, pnpm, yarn, bun):
        d.mkdir(parents=True, exist_ok=True)
    return {
        "NPM_CONFIG_CACHE": str(npm),
        "PNPM_STORE_DIR": str(pnpm),
        # Yarn 1 reads YARN_CACHE_FOLDER; Yarn 3+ uses YARN_GLOBAL_FOLDER too.
        "YARN_CACHE_FOLDER": str(yarn),
        "YARN_GLOBAL_FOLDER": str(yarn),
        "BUN_INSTALL_CACHE_DIR": str(bun),
    }


# ---------------------------------------------------------------------------
# Internal pipeline
# ---------------------------------------------------------------------------


async def _run_build(deployment_id) -> None:
    db: Session = SessionLocal()
    workspace: Optional[Path] = None
    workspace_is_persistent = False
    workspace_lock: Optional[object] = None
    build: Optional[Build] = None
    deployment: Optional[Deployment] = None
    project: Optional[Project] = None
    writer: Optional[_LogWriter] = None
    # Coerce string IDs to UUID. enqueue_build always passes str(deployment.id)
    # so that the value survives RQ's JSON-serialised job payload, but the
    # `Deployment.id` column is Uuid(as_uuid=True) and SQLAlchemy's UUID type
    # processor calls `.hex` on the parameter — works on UUID objects, blows
    # up with `'str' object has no attribute 'hex'` on bare strings. Without
    # this coercion every queued build dies on the very first query and the
    # deployment row sits at PENDING forever (the FastAPI BackgroundTasks
    # runner swallows the exception silently). See CLAUDE.md → "Things that
    # bite" → UUID coercion.
    if isinstance(deployment_id, str):
        try:
            deployment_id = UUID(deployment_id)
        except (ValueError, AttributeError):
            logger.error("Build runner: malformed deployment id %r", deployment_id)
            return
    try:
        deployment = db.query(Deployment).filter(Deployment.id == deployment_id).first()
        if not deployment:
            logger.error("Build runner: deployment %s not found", deployment_id)
            return

        project = deployment.project

        # Create / reset build record. The build_command is resolved a second
        # time *after* clone (once we can see the actual lockfile), so the
        # placeholder here just records intent for the queued state.
        build = Build(
            deployment_id=deployment.id,
            build_command=_resolve_build_command(db, project),
            status=BuildStatus.RUNNING,
            started_at=utcnow(),
        )
        db.add(build)
        deployment.status = DeploymentStatus.BUILDING
        deployment.started_at = utcnow()
        db.commit()
        db.refresh(build)

        writer = _LogWriter(db, build)
        append = writer.write

        # ── Workspace setup ────────────────────────────────────────────────
        # Try to grab the per-project lock; if held, fall back to a
        # per-deploy ephemeral workspace so concurrent deploys never race
        # on the same git checkout.
        workspace_lock = _acquire_workspace_lock(project.id)
        if workspace_lock is not None:
            workspace = _WORKSPACES_DIR / str(project.id)
            workspace_is_persistent = True
        else:
            workspace = BUILD_BASE / str(deployment.id)
        workspace.mkdir(parents=True, exist_ok=True)
        repo_dir = workspace / "repo"

        append(f"[WatchTower] Build started at {utcnow().isoformat()}")
        append(f"[WatchTower] Project: {project.name}  |  Branch: {deployment.branch}")
        if workspace_is_persistent:
            append("[WatchTower] Reusing per-project workspace + package cache")

        # ── Step 1: Clone / pull repo ──────────────────────────────────────
        clone_url = _resolve_clone_url(db, project, append)
        ok, err = await _clone_repo(
            clone_url,
            deployment.branch,
            repo_dir,
            append,
            display_url=project.repo_url,
            allow_reuse=workspace_is_persistent,
        )
        if not ok:
            raise RuntimeError(f"Git clone failed: {err}")

        # ── Step 2: Resolve env vars ───────────────────────────────────────
        env_vars = _load_env_vars(db, project)
        # Inject per-project package-manager caches. User env vars win on
        # collision so an operator who really wants $NPM_CONFIG_CACHE
        # pointed elsewhere can still override.
        cache_env = _pkg_cache_env(project.id)
        merged_env = {**cache_env, **env_vars}

        # ── Step 3: Run build command ──────────────────────────────────────
        # Re-resolve now that we can inspect the cloned repo. If the user
        # set Project.build_command explicitly we honour that. Otherwise we
        # pick npm/pnpm/yarn/bun based on the lockfile actually present —
        # avoids the `npm ci` failure when a project has no package-lock.json.
        build_cmd = _resolve_build_command(db, project, repo_dir=repo_dir)
        if build_cmd != build.build_command:
            build.build_command = build_cmd
            db.commit()
        if build_cmd:
            append(f"\n[WatchTower] Running build: {build_cmd}")
            ok, err = await _run_cmd(
                build_cmd, cwd=repo_dir, env_vars=merged_env, append=append
            )
            if not ok:
                raise RuntimeError(f"Build command failed: {err}")
        else:
            append("[WatchTower] No build command — skipping build step.")

        # ── Step 4: Deploy to nodes (in parallel) ──────────────────────────
        output_path = _resolve_output_path(db, project, repo_dir)
        nodes = _get_deployment_nodes(db, deployment)

        if nodes:
            deployment.status = DeploymentStatus.DEPLOYING
            writer.flush()
            db.commit()
            append(f"\n[WatchTower] Deploying to {len(nodes)} node(s) in parallel…")
            results = await asyncio.gather(
                *[_deploy_to_one_node(node, output_path, append) for node in nodes],
                return_exceptions=True,
            )
            failures: list[tuple[str, str]] = []
            for node, result in zip(nodes, results):
                label = node.host or "node"
                if isinstance(result, BaseException):
                    failures.append((label, str(result)))
                    continue
                ok, err = result  # type: ignore[misc]
                if not ok:
                    failures.append((label, err))
            if failures:
                joined = "; ".join(f"{h}: {e}" for h, e in failures)
                raise RuntimeError(
                    f"Deploy failed on {len(failures)}/{len(nodes)} node(s): {joined}"
                )
        else:
            append("[WatchTower] ⚠ No deployment nodes configured — build artifacts stored locally only.")

        # ── Step 5: Mark success ───────────────────────────────────────────
        append(f"\n[WatchTower] ✅ Build complete at {utcnow().isoformat()}")
        writer.flush()
        build.status = BuildStatus.SUCCESS
        build.completed_at = utcnow()
        deployment.status = DeploymentStatus.LIVE
        deployment.completed_at = utcnow()
        db.commit()

        await _send_notifications(db, project, deployment, success=True)

    except Exception as exc:
        logger.exception("Build runner error for deployment %s", deployment_id)
        try:
            if build:
                # Make sure any buffered lines are persisted before we
                # overwrite build_output with the failure tail.
                if writer is not None:
                    writer.flush()
                output = build.build_output or ""
                hint = _humanize_failure(output, build.build_command or "")
                tail = f"\n[WatchTower] ❌ {exc}"
                if hint:
                    tail += f"\n\n[WatchTower] 💡 {hint}"
                build.build_output = output + tail
                build.status = BuildStatus.FAILED
                build.completed_at = utcnow()
            if deployment:
                deployment.status = DeploymentStatus.FAILED
                deployment.completed_at = utcnow()
            db.commit()
            await _send_notifications(db, project, deployment, success=False)
        except Exception:
            pass
    finally:
        # Final log flush so any tail lines from success/failure paths
        # actually land in the DB rather than being orphaned in memory.
        if writer is not None:
            try:
                writer.flush()
            except Exception:
                pass
        db.close()
        # Ephemeral per-deploy workspaces get deleted to avoid disk
        # fill-up. Persistent per-project workspaces stay so the next
        # build can reuse the git history and node_modules.
        if workspace and workspace.exists() and not workspace_is_persistent:
            try:
                shutil.rmtree(workspace)
            except Exception:
                pass
        _release_workspace_lock(workspace_lock)


# ---------------------------------------------------------------------------
# Multi-node deploy helper (parallel)
# ---------------------------------------------------------------------------


async def _deploy_to_one_node(
    node: OrgNode,
    output_path: Path,
    append: Callable[[str], None],
) -> tuple[bool, str]:
    """Rsync + reload one node, prefixing every log line with the node host
    so parallel deploys produce readable interleaved output. Returns
    ``(ok, error)`` — never raises.
    """
    label = node.host or "node"
    prefix = f"[{label}] "
    try:
        ok, err = await _rsync_to_node(node, output_path, append, prefix=prefix)
        if not ok:
            return False, err
        if node.reload_command:
            append(f"{prefix}Reloading service…")
            ok, err = await _ssh_run(node, node.reload_command, append, prefix=prefix)
            if not ok:
                # Reload failure is logged loudly but doesn't abort the
                # deploy — files already landed. Surface as a warning,
                # same as the previous sequential path did.
                append(f"{prefix}⚠ Reload command failed: {err}")
        return True, ""
    except Exception as exc:
        return False, str(exc)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _clone_repo(
    repo_url: str,
    branch: str,
    dest: Path,
    append,
    display_url: Optional[str] = None,
    allow_reuse: bool = False,
) -> tuple[bool, str]:
    """Bring *dest* up to date with *repo_url* @ *branch*.

    When ``allow_reuse`` is true and *dest* is already a git checkout, we
    do an incremental ``git fetch + reset --hard`` instead of a fresh
    clone. Saves a full repo-content download on every build, which on
    large monorepos can dominate the build time.
    """
    # Local-folder source: the wizard stores the path as `local://<abs path>`.
    # Git would treat `local://` as a remote-helper scheme and fail with
    # "git: 'remote-local' is not a git command". Copy/sync the directory
    # instead so deploys work for projects that aren't backed by a git remote.
    if repo_url.startswith("local://"):
        src = Path(repo_url.removeprefix("local://"))
        if not src.is_dir():
            msg = f"source folder not found: {src}"
            append(f"[local] {msg}")
            return False, msg
        # rsync is dramatically faster than shutil.copytree for repeated
        # syncs of the same source — it only copies changed bytes. Falls
        # back to copytree when rsync is unavailable.
        if shutil.which("rsync"):
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.mkdir(parents=True, exist_ok=True)
            append(f"[local] Syncing {src} → build dir…")
            cmd = [
                "rsync", "-a", "--delete",
                "--exclude=.git/", "--exclude=node_modules/",
                "--exclude=__pycache__/", "--exclude=.venv/",
                "--exclude=dist/", "--exclude=build/",
                f"{str(src).rstrip('/')}/", f"{str(dest).rstrip('/')}/",
            ]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            rc = await _stream_proc(proc, append, prefix="[local] ")
            if rc != 0:
                return False, f"rsync exit {rc}"
            return True, ""
        # No rsync available — fresh copytree (slower, but works).
        if dest.exists():
            shutil.rmtree(dest)
        append(f"[local] Copying {src} → build dir…")
        try:
            shutil.copytree(
                src,
                dest,
                symlinks=True,
                ignore=shutil.ignore_patterns(
                    ".git", "node_modules", "__pycache__", ".venv", "dist", "build",
                ),
            )
        except Exception as exc:
            append(f"[local] copy failed: {exc}")
            return False, str(exc)
        return True, ""

    shown = display_url or _redact_url(repo_url)

    # Reuse path: existing git checkout → fetch + reset to the requested
    # branch tip. This is the workhorse of the "persistent workspace"
    # optimization. Anything that can't be brought up cleanly falls
    # through to a fresh clone below.
    if allow_reuse and (dest / ".git").is_dir():
        append(f"[git] Updating existing checkout @ {branch}…")
        # Re-point origin to the (possibly token-rewritten) URL — the
        # token will have rotated since the last build.
        await _git_quiet(["git", "-C", str(dest), "remote", "set-url", "origin", repo_url])
        proc = await asyncio.create_subprocess_exec(
            "git", "-C", str(dest),
            "fetch", "--depth=1", "origin", branch,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        rc = await _stream_proc(proc, append, prefix="[git] ")
        if rc == 0:
            proc = await asyncio.create_subprocess_exec(
                "git", "-C", str(dest), "reset", "--hard", "FETCH_HEAD",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            rc = await _stream_proc(proc, append, prefix="[git] ")
            if rc == 0:
                # Drop untracked junk (stale build outputs, etc.) but
                # keep node_modules — that's the cache the workspace
                # exists to preserve.
                proc = await asyncio.create_subprocess_exec(
                    "git", "-C", str(dest),
                    "clean", "-fdx", "--exclude=node_modules", "--exclude=.next/cache",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
                await _stream_proc(proc, append, prefix="[git] ")
                return True, ""
        # Reuse path failed — wipe and fall through to fresh clone.
        append("[git] Existing checkout couldn't be updated; falling back to fresh clone")
        try:
            shutil.rmtree(dest)
        except Exception:
            pass

    if dest.exists():
        shutil.rmtree(dest)
    append(f"[git] Cloning {shown} @ {branch}…")
    proc = await asyncio.create_subprocess_exec(
        "git", "clone", "--depth=1", "--single-branch", "--branch", branch, repo_url, str(dest),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )

    # Capture lines into a buffer first so we can run them through the
    # URL redactor before they reach the log — git's stderr can echo back
    # the embedded x-access-token: PAT on auth failure.
    captured: list[str] = []
    rc = await _stream_proc(proc, captured.append)
    for line in captured:
        append(f"[git] {_redact_url(line)}")
    if rc != 0:
        return False, _redact_url("\n".join(captured))
    return True, ""


async def _git_quiet(cmd: list[str]) -> int:
    """Run a git command discarding output; returns exit code."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    return await proc.wait()


def _redact_url(text: str) -> str:
    """Strip credentials from any URL embedded in *text* before logging."""
    return re.sub(
        r"(https?://)([^/@\s]+)@",
        lambda m: f"{m.group(1)}***@",
        text,
    )


def _resolve_clone_url(db: Session, project: Project, append) -> str:
    """Return a clone URL with an embedded PAT when one is available.

    Looks up an active GitHubConnection on the project's org and rewrites
    https://github.com/... or enterprise URLs to
    https://x-access-token:<pat>@host/... so that private repos can be cloned
    without requiring git credential helpers on the host.
    """
    repo_url = project.repo_url or ""
    if not repo_url.startswith("https://"):
        return repo_url  # ssh://, git@, file://, etc. — leave untouched

    if not project.org_id:
        return repo_url

    try:
        connection = (
            db.query(GitHubConnection)
            .filter(
                GitHubConnection.org_id == project.org_id,
                GitHubConnection.is_active == True,  # noqa: E712
            )
            .order_by(
                GitHubConnection.is_primary.desc(),
                GitHubConnection.created_at.desc(),
            )
            .first()
        )
    except Exception:
        logger.exception("Failed to query GitHubConnection for org %s", project.org_id)
        return repo_url

    if not connection or not connection.github_access_token:
        return repo_url

    # Decrypt lazily — if the secret key isn't configured we silently fall
    # back to an unauthenticated clone (which is fine for public repos).
    try:
        from watchtower.api import util as _util
        token = _util.decrypt_secret(connection.github_access_token)
    except Exception:
        logger.warning("Could not decrypt GitHub token; proceeding without auth")
        return repo_url

    if not token:
        return repo_url

    # Only inject for the connection's host — never leak a token to
    # arbitrary third-party hosts.
    parts = urlsplit(repo_url)
    target_host = parts.hostname or ""
    expected_host = "github.com"
    if connection.enterprise_url:
        try:
            expected_host = (urlsplit(connection.enterprise_url).hostname or expected_host)
        except Exception:
            pass
    if target_host.lower() != expected_host.lower():
        return repo_url

    netloc = f"x-access-token:{token}@{target_host}"
    if parts.port:
        netloc += f":{parts.port}"
    authed = urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
    try:
        append(f"[git] Using stored GitHub credentials for @{connection.github_username or 'connected-account'}")
    except Exception:
        pass
    return authed


async def _run_cmd(
    cmd: str,
    cwd: Path,
    env_vars: dict,
    append,
    timeout: int = 600,
) -> tuple[bool, str]:
    env = {**os.environ, **env_vars}
    # BuildKit gives us --cache-from semantics + remote cache reuse for
    # `docker build`, so default it on. Operator can still set
    # DOCKER_BUILDKIT=0 in env_vars to override if a particular Dockerfile
    # is incompatible.
    env.setdefault("DOCKER_BUILDKIT", "1")
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            cwd=str(cwd),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            rc = await asyncio.wait_for(_stream_proc(proc, append), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return False, f"Build timed out after {timeout}s"
        if rc != 0:
            return False, f"exit code {rc}"
        return True, ""
    except Exception as exc:
        return False, str(exc)


# Hosts that mean "this machine" — we skip SSH and rsync directly.
# A user evaluating WatchTower on a single laptop hits this path: their
# "local node" is just an SSH target pointing at 127.0.0.1, but Remote
# Login is off and ~/.ssh/id_rsa doesn't exist, so SSH-to-self errors.
# Detecting localhost lets us avoid the entire SSH/keypair yak-shave for
# what is fundamentally `cp -a` + `bash -c reload`.
_LOCALHOST_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _is_local_node(node: OrgNode) -> bool:
    return (node.host or "").strip().lower() in _LOCALHOST_HOSTS


async def _rsync_to_node(
    node: OrgNode,
    src: Path,
    append,
    prefix: str = "",
) -> tuple[bool, str]:
    # ── Local-node fast path: skip SSH entirely ────────────────────────────
    # rsync to a local path runs as the WatchTower process user (no
    # node.user impersonation — that field is meaningless without SSH).
    # We mkdir -p the destination first because nothing else on this code
    # path guarantees it exists, and the cryptic rsync error for a
    # missing directory ("No such file or directory") obscures the real
    # issue when a user just registered a fresh local node.
    if _is_local_node(node):
        dest = f"{node.remote_path.rstrip('/')}/"
        try:
            Path(dest).mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return False, f"could not create local dest {dest}: {exc}"
        cmd = ["rsync", "-az", "--delete", f"{src}/", dest]
        append(f"{prefix}[rsync] → {dest} (local)")
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        captured: list[str] = []
        rc = await _stream_proc(proc, captured.append)
        for line in captured:
            append(f"{prefix}[rsync] {line}")
        if rc != 0:
            return False, "\n".join(captured)
        return True, ""

    # ── Remote SSH path (existing behaviour) ───────────────────────────────
    # All node-* fields below originate from an authenticated org admin via
    # the API, but we still treat them as untrusted because rsync's ``-e``
    # flag is parsed by a shell on the local machine. Quote every piece
    # that lands inside the ``-e`` string to prevent command injection like
    # ``ssh_key_path = "/tmp/k; rm -rf /"`` (CWE-78).
    port = int(node.port)  # cast → ValueError on injection attempt
    dest = f"{node.user}@{node.host}:{node.remote_path}/"
    ssh_parts = [
        "ssh",
        "-o", "StrictHostKeyChecking=accept-new",
        "-p", str(port),
    ]
    if node.ssh_key_path:
        ssh_parts += ["-i", node.ssh_key_path]
    ssh_e = " ".join(shlex.quote(p) for p in ssh_parts)
    cmd = [
        "rsync", "-az", "--delete",
        "-e", ssh_e,
        f"{src}/", dest,
    ]
    append(f"{prefix}[rsync] → {dest}")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    captured: list[str] = []
    rc = await _stream_proc(proc, captured.append)
    for line in captured:
        append(f"{prefix}[rsync] {line}")
    if rc != 0:
        return False, "\n".join(captured)
    return True, ""


async def _ssh_run(
    node: OrgNode,
    command: str,
    append,
    prefix: str = "",
) -> tuple[bool, str]:
    # ── Local-node fast path: run reload command as a local subprocess ─────
    # We feed the command through ``bash -lc`` so the same reload script
    # the user wrote for SSH (e.g. "cd /opt/app && pm2 restart api")
    # works unchanged — it's just running on this machine instead of via
    # ssh. The cwd is set to remote_path so relative paths in the script
    # resolve where the deployed files live.
    if _is_local_node(node):
        cwd = node.remote_path or None
        if cwd:
            try:
                Path(cwd).mkdir(parents=True, exist_ok=True)
            except OSError:
                cwd = None  # fall back to inheriting WatchTower's cwd
        append(f"{prefix}[local] $ {command}")
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=cwd,
        )
        captured: list[str] = []
        rc = await _stream_proc(proc, captured.append)
        for line in captured:
            append(f"{prefix}[local] {line}")
        if rc != 0:
            return False, "\n".join(captured)
        return True, ""

    # ── Remote SSH path ────────────────────────────────────────────────────
    ssh_opts = ["-p", str(node.port), "-o", "StrictHostKeyChecking=accept-new"]
    if node.ssh_key_path:
        ssh_opts += ["-i", node.ssh_key_path]
    cmd = ["ssh"] + ssh_opts + [f"{node.user}@{node.host}", command]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    captured: list[str] = []
    rc = await _stream_proc(proc, captured.append)
    for line in captured:
        append(f"{prefix}[ssh] {line}")
    if rc != 0:
        return False, "\n".join(captured)
    return True, ""


def _resolve_build_command(
    db: Session,
    project: Project,
    repo_dir: Optional[Path] = None,
) -> str:
    """Pick the install/build command for *project*.

    Resolution order:
      1. ``project.build_command`` if the user set one (honoured verbatim)
      2. Use-case default, with the install half chosen by lockfile inspection
         when ``repo_dir`` is provided

    Passing ``repo_dir`` is what enables npm-vs-pnpm-vs-yarn-vs-bun detection.
    The placeholder pre-clone call (no repo_dir) falls back to ``npm install``
    so a lockfile-less project doesn't immediately fail with the cryptic
    ``npm ci`` help-text dump that prompted this whole rewrite.
    """
    if project.build_command:
        return project.build_command

    if project.use_case == UseCaseType.DOCKER_PLATFORM:
        cfg = db.query(DockerPlatformConfig).filter_by(project_id=project.id).first()
        dockerfile = cfg.dockerfile_path if cfg else "Dockerfile"
        # --cache-from + BUILDKIT_INLINE_CACHE lets layer reuse work
        # across builds of the same project. On the first build the
        # cache image doesn't exist; BuildKit silently no-ops
        # --cache-from for missing images, so this is safe.
        cache_tag = f"watchtower-{project.id}:cache"
        latest_tag = f"watchtower-{project.id}:latest"
        return (
            f"docker build "
            f"--cache-from {cache_tag} "
            f"--build-arg BUILDKIT_INLINE_CACHE=1 "
            f"-t {latest_tag} -t {cache_tag} "
            f"-f {dockerfile} ."
        )

    if project.use_case in (UseCaseType.NETLIFY_LIKE, UseCaseType.VERCEL_LIKE):
        install = _detect_node_install(repo_dir) if repo_dir else "npm install"
        return f"{install} && npm run build"

    return ""


def _detect_node_install(repo_dir: Path) -> str:
    """Pick the install command based on whichever lockfile lives in *repo_dir*.

    Order matches typical project precedence: a project with both pnpm and
    npm lockfiles is overwhelmingly a pnpm project that has a stale
    package-lock.json from earlier in its history.
    """
    if (repo_dir / "pnpm-lock.yaml").exists():
        return "pnpm install --frozen-lockfile"
    if (repo_dir / "yarn.lock").exists():
        return "yarn install --frozen-lockfile"
    if (repo_dir / "bun.lockb").exists() or (repo_dir / "bun.lock").exists():
        return "bun install --frozen-lockfile"
    if (repo_dir / "package-lock.json").exists():
        return "npm ci"
    # No lockfile: `npm ci` would fail with a help-text dump. Fall back to
    # plain `npm install` which works without a lockfile and generates one.
    return "npm install"


# Build-failure patterns we know how to translate into a one-line nudge.
# Each (id, predicate, hint) tuple is checked in order; first match wins.
_FAILURE_HINTS: list[tuple[str, Callable[[str, str], bool], str]] = [
    (
        "npm-ci-no-lockfile",
        lambda out, cmd: (
            "npm ci" in cmd
            and "npm error" in out
            and (
                "package-lock.json" in out
                or "ic, install-clean, isntall-clean" in out
                or "clean-install" in out
            )
        ),
        (
            "Build runs `npm ci`, which requires a `package-lock.json`. "
            "Either commit a lockfile to the repo, or open Project Settings "
            "and change the build command to `npm install && npm run build`."
        ),
    ),
    (
        "missing-package-json",
        lambda out, cmd: "ENOENT" in out and "package.json" in out,
        (
            "No `package.json` found in the repo root. If your app lives in "
            "a subdirectory, override the build command to `cd <dir> && "
            "npm install && npm run build`."
        ),
    ),
    (
        "missing-dockerfile",
        lambda out, cmd: cmd.startswith("docker build") and "Dockerfile" in out and "no such file" in out.lower(),
        (
            "`docker build` couldn't find the Dockerfile. Set its path under "
            "Project Settings → Dockerfile path."
        ),
    ),
]


def _humanize_failure(output: str, build_cmd: str) -> Optional[str]:
    """Return a one-line operator-friendly hint for a known build failure."""
    if not output:
        return None
    for _id, predicate, hint in _FAILURE_HINTS:
        try:
            if predicate(output, build_cmd):
                return hint
        except Exception:
            continue
    return None


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
    Verify the node is reachable for deployment.

    For local nodes (127.0.0.1 / localhost / ::1) we don't go through
    SSH at all (deploys use the local-fast-path in _rsync_to_node /
    _ssh_run). The "health" check just confirms remote_path is writable
    by the WatchTower process user — that's the only thing that can
    actually fail at deploy time on a local node.

    Returns (success, message).
    """
    if _is_local_node(node):
        path = node.remote_path or ""
        if not path:
            return True, "Local node registered (no remote_path set)"
        try:
            p = Path(path)
            p.mkdir(parents=True, exist_ok=True)
            probe = p / ".watchtower-write-probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
            return True, f"Local node ready ({path} writable)"
        except OSError as exc:
            return False, f"Local node {path} not writable: {exc}"

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
    # Lockfile-less default. The runner re-resolves to `npm ci` (or pnpm /
    # yarn / bun) once the repo is cloned and the lockfile is visible —
    # this string is just the wizard's "first guess" to show the user.
    build_command = "npm install && npm run build"
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
    # Default to a lockfile-less install so the wizard's first guess works
    # for fresh repos. The runner picks the right install command (npm ci /
    # pnpm / yarn / bun) at deploy time once the lockfile is visible.
    build_cmd = scripts.get("build", "npm run build")
    if "install" not in build_cmd and "npm ci" not in build_cmd:
        build_cmd = f"npm install && {build_cmd}"

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
