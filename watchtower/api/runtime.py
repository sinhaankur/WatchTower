"""Runtime endpoints for Podman and WatchTower operations."""

from __future__ import annotations

import json
import logging
import os
import re
import signal
import shlex
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

import watchtower
from watchtower.api import util

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/runtime", tags=["Runtime"])

ROOT_DIR = Path(__file__).resolve().parents[2]
DEV_DIR = ROOT_DIR / ".dev"
PID_FILE = DEV_DIR / "watchtower-service.pid"
LOG_FILE = DEV_DIR / "watchtower-service.log"
TERMINAL_AUDIT_FILE = DEV_DIR / "terminal-audit.log.enc"
TERMINAL_MAX_OUTPUT = 12000
TERMINAL_MAX_ARGS = 20
TERMINAL_MAX_ARG_LENGTH = 300

try:
    from cryptography.fernet import Fernet
except Exception:  # pragma: no cover - optional import in some envs
    Fernet = None  # type: ignore[assignment]


TERMINAL_ALLOWED_COMMANDS = {
    "docker": {"allow_sudo": True, "must_sudo": False},
    "podman": {"allow_sudo": True, "must_sudo": False},
    "systemctl": {"allow_sudo": True, "must_sudo": True},
    "journalctl": {"allow_sudo": True, "must_sudo": False},
    "tailscale": {"allow_sudo": True, "must_sudo": False},
    "cloudflared": {"allow_sudo": True, "must_sudo": False},
    "nginx": {"allow_sudo": True, "must_sudo": True},
    "ls": {"allow_sudo": False, "must_sudo": False},
    "pwd": {"allow_sudo": False, "must_sudo": False},
    "whoami": {"allow_sudo": False, "must_sudo": False},
    "id": {"allow_sudo": False, "must_sudo": False},
    "uname": {"allow_sudo": False, "must_sudo": False},
    "df": {"allow_sudo": False, "must_sudo": False},
    "free": {"allow_sudo": False, "must_sudo": False},
    "uptime": {"allow_sudo": False, "must_sudo": False},
}


class DomainConnectRequest(BaseModel):
    domain: str = Field(min_length=3)
    subdomain: str = Field(default="app")
    target_host: str = Field(
        default="localhost:3000",
        description="Local service endpoint exposed by cloudflared",
    )


class DatabasePlanRequest(BaseModel):
    provider: str = Field(
        description=(
            "mongodb_atlas | aws_rds_postgres | oracle_freedb | supabase"
        )
    )
    app_name: str = Field(default="watchtower-app")
    db_name: str = Field(default="appdb")
    username: str = Field(default="appuser")
    region: str = Field(default="us-east-1")


class NginxConfigRequest(BaseModel):
    server_name: str = Field(default="app.example.com")
    upstream_host: str = Field(default="127.0.0.1:3000")


class VSCodeOpenRequest(BaseModel):
    path: str = Field(min_length=1, description="Absolute path to open in VS Code")


class TerminalCommandRequest(BaseModel):
    command: str = Field(min_length=1, max_length=1200)
    require_sudo: bool = Field(default=False)
    timeout_seconds: int = Field(default=20, ge=1, le=120)


def _get_terminal_audit_fernet() -> Fernet:
    key = os.getenv("WATCHTOWER_TERMINAL_AUDIT_KEY", "").strip()
    if not key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Terminal execution is disabled until WATCHTOWER_TERMINAL_AUDIT_KEY "
                "is configured for encrypted audit logging."
            ),
        )
    if Fernet is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Terminal execution requires the 'cryptography' package for "
                "encrypted audit logging."
            ),
        )
    try:
        return Fernet(key.encode("utf-8"))
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "WATCHTOWER_TERMINAL_AUDIT_KEY is invalid. Expected a valid "
                "Fernet key (44-char URL-safe base64)."
            ),
        ) from exc


def _truncate_terminal_output(text: str) -> str:
    if len(text) <= TERMINAL_MAX_OUTPUT:
        return text
    suffix = "\n...[output truncated for safety]"
    return text[: TERMINAL_MAX_OUTPUT - len(suffix)] + suffix


# Hand-curated allowlist of short, well-known credential flags. The regex
# below catches the long-form variants (--api-key, --bearer, etc.) — this
# set covers single-letter or non-suffix flags the regex won't match.
_SENSITIVE_SHORT_FLAGS = {"-p", "-P", "-T"}

# A flag whose name ends in PASSWORD/SECRET/TOKEN/KEY/PWD/PASSWD or starts
# with BEARER. Matches "--password", "--api-key", "--bearer-token",
# "-API_TOKEN", "--gh-pat" via PAT, etc. Case-insensitive so YAML-style
# "--Api-Key" is caught too. The optional ``[A-Za-z0-9_-]*`` lets bare
# suffixes like "--password" match (no prefix between dashes and suffix).
_SENSITIVE_FLAG_RE = re.compile(
    r"^--?[A-Za-z0-9_-]*"
    r"(PASSWORD|PASSWD|PWD|SECRET|TOKEN|KEY|BEARER|PAT)$",
    re.IGNORECASE,
)

# Match "FOO_TOKEN=bar", "API_KEY=bar", "password=bar", etc. — anything
# whose key half ends in a credential-y suffix.
_SENSITIVE_KV_RE = re.compile(
    r"^([A-Za-z][A-Za-z0-9_-]*"
    r"(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|KEY|BEARER|PAT))=",
    re.IGNORECASE,
)


def _redact_sensitive_tokens(args: list[str]) -> list[str]:
    """Drop secrets from a command-line argv before it lands in audit logs.

    Three patterns are redacted:
      1. Known short flags (``-p``) — the *next* token becomes ``***``.
      2. Long-form credential flags matched by ``_SENSITIVE_FLAG_RE``
         (``--api-key``, ``--bearer-token``, etc.) — same: next token
         redacted.
      3. ``KEY=value`` style where the key half ends in a credential
         suffix — the whole token becomes ``KEY=***`` so the key name
         is preserved for triage but the value is gone.
    """
    redact_next = False
    redacted: list[str] = []
    for value in args:
        if redact_next:
            redacted.append("***")
            redact_next = False
            continue
        if value in _SENSITIVE_SHORT_FLAGS or _SENSITIVE_FLAG_RE.match(value):
            redacted.append(value)
            redact_next = True
            continue
        kv_match = _SENSITIVE_KV_RE.match(value)
        if kv_match:
            redacted.append(f"{kv_match.group(1)}=***")
            continue
        redacted.append(value)
    return redacted


def _append_encrypted_terminal_audit(
    fernet: Fernet,
    *,
    user_id: str,
    command: str,
    args: list[str],
    require_sudo: bool,
    exit_code: int,
    success: bool,
) -> None:
    DEV_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "user_id": user_id,
        "command": command,
        "args": _redact_sensitive_tokens(args),
        "require_sudo": require_sudo,
        "exit_code": exit_code,
        "success": success,
    }
    encrypted = fernet.encrypt(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    )
    with TERMINAL_AUDIT_FILE.open("ab") as f:
        f.write(encrypted + b"\n")


def _execute_terminal_command(
    payload: TerminalCommandRequest,
    *,
    user_id: str,
) -> dict[str, Any]:
    fernet = _get_terminal_audit_fernet()

    try:
        parts = shlex.split(payload.command.strip(), posix=True)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid command syntax.",
        ) from exc

    if not parts:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Command cannot be empty.",
        )

    command_name = parts[0]
    args = parts[1:]
    policy = TERMINAL_ALLOWED_COMMANDS.get(command_name)
    if not policy:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Command is not allowed. Only approved operations commands "
                "are permitted."
            ),
        )

    if len(args) > TERMINAL_MAX_ARGS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Too many arguments. Maximum is {TERMINAL_MAX_ARGS}.",
        )

    if any(len(a) > TERMINAL_MAX_ARG_LENGTH for a in args):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "One or more arguments are too long. "
                f"Maximum argument length is {TERMINAL_MAX_ARG_LENGTH}."
            ),
        )

    if payload.require_sudo and not policy["allow_sudo"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Sudo is not permitted for this command.",
        )

    if policy["must_sudo"] and not payload.require_sudo:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This command must be run with sudo.",
        )

    final_cmd = [command_name, *args]
    if payload.require_sudo:
        final_cmd = ["sudo", "-n", *final_cmd]

    try:
        result = subprocess.run(
            final_cmd,
            capture_output=True,
            text=True,
            timeout=payload.timeout_seconds,
            cwd=str(ROOT_DIR),
            check=False,
        )
        stdout = _truncate_terminal_output(result.stdout.strip())
        stderr = _truncate_terminal_output(result.stderr.strip())
        success = result.returncode == 0
        _append_encrypted_terminal_audit(
            fernet,
            user_id=user_id,
            command=command_name,
            args=args,
            require_sudo=payload.require_sudo,
            exit_code=result.returncode,
            success=success,
        )
        return {
            "ok": success,
            "command": command_name,
            "args": _redact_sensitive_tokens(args),
            "require_sudo": payload.require_sudo,
            "exit_code": result.returncode,
            "stdout": stdout,
            "stderr": stderr,
        }
    except subprocess.TimeoutExpired as exc:
        _append_encrypted_terminal_audit(
            fernet,
            user_id=user_id,
            command=command_name,
            args=args,
            require_sudo=payload.require_sudo,
            exit_code=124,
            success=False,
        )
        raise HTTPException(
            status_code=status.HTTP_408_REQUEST_TIMEOUT,
            detail="Command timed out.",
        ) from exc
    except FileNotFoundError as exc:
        _append_encrypted_terminal_audit(
            fernet,
            user_id=user_id,
            command=command_name,
            args=args,
            require_sudo=payload.require_sudo,
            exit_code=127,
            success=False,
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Command not found: {command_name}",
        ) from exc


def _command_exists(command: str) -> bool:
    ok, _, _, _ = _run_cmd(["which", command], timeout=3)
    return ok


def _tool_status(command: str, version_args: list[str]) -> dict[str, Any]:
    if not _command_exists(command):
        return {"installed": False, "version": None}
    _, out, err, _ = _run_cmd([command, *version_args], timeout=5)
    return {
        "installed": True,
        "version": out or err or "unknown",
    }


def _docker_status() -> dict[str, Any]:
    meta = _tool_status("docker", ["--version"])
    if not meta["installed"]:
        return {
            **meta,
            "daemon_available": False,
            "running_containers": 0,
            "sample_containers": [],
        }

    info_ok, _, _, _ = _run_cmd(["docker", "info"], timeout=8)
    ps_ok, ps_out, _, _ = _run_cmd(
        ["docker", "ps", "--format", "json"],
        timeout=10,
    )
    sample_containers: list[dict[str, str]] = []

    if ps_ok and ps_out:
        # docker ps --format json may return:
        #   - one JSON array per invocation (newer Docker / Podman),  or
        #   - one JSON object per line (older Docker)
        raw = ps_out.strip()
        rows: list[Any] = []
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                rows = parsed          # whole-array format
            else:
                rows = [parsed]        # shouldn't happen but handle it
        except json.JSONDecodeError:
            # Fall back to line-by-line
            for line in raw.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    if isinstance(obj, dict):
                        rows.append(obj)
                    elif isinstance(obj, list):
                        rows.extend(obj)
                except json.JSONDecodeError:
                    continue

        for row in rows[:5]:
            if not isinstance(row, dict):
                continue
            names = row.get("Names", row.get("Name", "unknown"))
            if isinstance(names, list):
                names = names[0] if names else "unknown"
            sample_containers.append(
                {
                    "name": str(names),
                    "image": row.get("Image", "unknown"),
                    "state": row.get("State", row.get("Status", "unknown")),
                }
            )

    return {
        **meta,
        "daemon_available": info_ok,
        "running_containers": len(sample_containers),
        "sample_containers": sample_containers,
    }


def _tailscale_status() -> dict[str, Any]:
    meta = _tool_status("tailscale", ["version"])
    if not meta["installed"]:
        return {
            **meta,
            "connected": False,
            "ip": None,
            "hostname": None,
        }

    ip_ok, ip_out, _, _ = _run_cmd(["tailscale", "ip", "-4"], timeout=6)
    connected = ip_ok and bool(ip_out.strip())
    status_ok, status_out, _, _ = _run_cmd(
        ["tailscale", "status", "--json"],
        timeout=8,
    )

    hostname = None
    if status_ok and status_out:
        try:
            parsed = json.loads(status_out)
            self_data = parsed.get("Self") or {}
            hostname = self_data.get("HostName") or self_data.get("DNSName")
        except json.JSONDecodeError:
            hostname = None

    return {
        **meta,
        "connected": connected,
        "ip": ip_out.splitlines()[0] if connected else None,
        "hostname": hostname,
    }


def _cloudflared_status() -> dict[str, Any]:
    meta = _tool_status("cloudflared", ["--version"])
    if not meta["installed"]:
        return {
            **meta,
            "authenticated": False,
            "tunnels": [],
        }

    # This command can fail if user is not authenticated yet.
    list_ok, list_out, list_err, _ = _run_cmd(
        ["cloudflared", "tunnel", "list", "--output", "json"], timeout=10
    )
    if not list_ok:
        return {
            **meta,
            "authenticated": False,
            "tunnels": [],
            "auth_hint": list_err or "Run 'cloudflared tunnel login' first.",
        }

    tunnels: list[dict[str, str]] = []
    try:
        parsed = json.loads(list_out)
        for row in (parsed if isinstance(parsed, list) else [])[:10]:
            tunnels.append(
                {
                    "id": row.get("id", ""),
                    "name": row.get("name", ""),
                    "status": row.get("status", "unknown"),
                }
            )
    except json.JSONDecodeError:
        tunnels = []

    return {
        **meta,
        "authenticated": True,
        "tunnels": tunnels,
    }


def _coolify_status() -> dict[str, Any]:
    cli = _tool_status("coolify", ["--version"])
    if cli["installed"]:
        return {
            "installed": True,
            "version": cli["version"],
            "source": "coolify-cli",
        }

    # Fallback check: running Coolify container on host.
    docker_ok, docker_ps_out, _, _ = _run_cmd(
        ["docker", "ps", "--format", "json"], timeout=8
    )
    if docker_ok and docker_ps_out:
        raw = docker_ps_out.strip()
        rows: list[Any] = []
        try:
            parsed = json.loads(raw)
            rows = parsed if isinstance(parsed, list) else [parsed]
        except json.JSONDecodeError:
            for line in raw.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    rows.extend(obj if isinstance(obj, list) else [obj])
                except json.JSONDecodeError:
                    continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            image = (row.get("Image") or "").lower()
            if "coolify" in image:
                return {
                    "installed": True,
                    "version": "container-running",
                    "source": "docker-container",
                }

    return {
        "installed": False,
        "version": None,
        "source": "not-detected",
    }


def _nginx_status() -> dict[str, Any]:
    meta = _tool_status("nginx", ["-v"])
    if not meta["installed"]:
        return {
            **meta,
            "config_test_ok": False,
            "running": False,
        }

    test_ok, _, test_err, _ = _run_cmd(["nginx", "-t"], timeout=8)
    active = _systemd_status("nginx.service") == "active"
    return {
        **meta,
        "config_test_ok": test_ok,
        "running": active,
        "config_test_output": test_err,
    }


def _database_plan(payload: DatabasePlanRequest) -> dict[str, Any]:
    provider = payload.provider.strip().lower()

    if provider == "mongodb_atlas":
        return {
            "provider": "MongoDB Atlas",
            "id": provider,
            "steps": [
                "Create a free Atlas cluster and database user.",
                "Allow your server IP in Network Access list.",
                "Get SRV URI and store as secret, not plaintext env.",
            ],
            "connection_example": (
                f"mongodb+srv://{payload.username}:<password>@"
                "cluster0.xxxxx.mongodb.net/"
                f"{payload.db_name}?retryWrites=true&w=majority"
            ),
            "env": {
                "MONGODB_URI": "<atlas-srv-uri>",
                "MONGODB_DB_NAME": payload.db_name,
            },
            "notes": [
                "Use podman secrets for MONGODB_URI.",
                "Enable TLS (default for Atlas SRV URLs).",
            ],
        }

    if provider == "aws_rds_postgres":
        return {
            "provider": "AWS RDS PostgreSQL",
            "id": provider,
            "steps": [
                "Create PostgreSQL RDS instance on free-tier eligible class.",
                "Open security group to app subnet or trusted IP only.",
                "Create application database and least-privilege role.",
            ],
            "connection_example": (
                f"postgresql://{payload.username}:<password>@"
                f"<rds-endpoint>.{payload.region}.rds.amazonaws.com:5432/"
                f"{payload.db_name}?sslmode=require"
            ),
            "env": {
                "DATABASE_URL": "<rds-postgres-url>",
                "PGSSLMODE": "require",
            },
            "notes": [
                "Keep backup retention enabled.",
                "Prefer private networking for production.",
            ],
        }

    if provider == "oracle_freedb":
        return {
            "provider": "Oracle FreeDB / Autonomous",
            "id": provider,
            "steps": [
                "Create Oracle cloud free database instance.",
                "Create app user schema and grant minimal permissions.",
                "Download wallet if required by chosen Oracle mode.",
            ],
            "connection_example": (
                "oracle+oracledb://"
                f"{payload.username}:<password>@<host>:1521/?"
                "service_name=<service>"
            ),
            "env": {
                "ORACLE_DSN": "<oracle-dsn>",
                "ORACLE_USER": payload.username,
                "ORACLE_PASSWORD": "<password>",
            },
            "notes": [
                "If wallet auth is required, mount wallet files securely.",
                "Use TLS-enabled endpoint whenever available.",
            ],
        }

    if provider == "supabase":
        return {
            "provider": "Supabase Postgres",
            "id": provider,
            "steps": [
                "Create project in Supabase and wait for database ready.",
                (
                    "Copy pooled Postgres connection string "
                    "from project settings."
                ),
                "Store service role key and DB URL as secrets.",
            ],
            "connection_example": (
                "postgresql://postgres:<password>@"
                "db.<project-ref>.supabase.co:5432/postgres?sslmode=require"
            ),
            "env": {
                "DATABASE_URL": "<supabase-postgres-url>",
                "SUPABASE_URL": "https://<project-ref>.supabase.co",
                "SUPABASE_ANON_KEY": "<anon-key>",
                "SUPABASE_SERVICE_ROLE_KEY": "<service-role-key>",
            },
            "notes": [
                "Use row-level security if client apps connect directly.",
                "Prefer pooled connection endpoint for scale.",
            ],
        }

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=(
            "Unsupported provider. Use mongodb_atlas, aws_rds_postgres, "
            "oracle_freedb, or supabase."
        ),
    )


def _nginx_proxy_config(payload: NginxConfigRequest) -> str:
    server_name = payload.server_name.strip()
    upstream = payload.upstream_host.strip()
    lines = [
        "server {",
        "    listen 80;",
        f"    server_name {server_name};",
        "",
        "    location / {",
        f"        proxy_pass http://{upstream};",
        "        proxy_http_version 1.1;",
        "        proxy_set_header Host $host;",
        "        proxy_set_header X-Real-IP $remote_addr;",
        "        proxy_set_header X-Forwarded-For"
        " $proxy_add_x_forwarded_for;",
        "        proxy_set_header X-Forwarded-Proto $scheme;",
        "        proxy_set_header Upgrade $http_upgrade;",
        '        proxy_set_header Connection "upgrade";',
        "    }",
        "}",
    ]
    return "\n".join(lines) + "\n"


def _linux_install_commands() -> dict[str, list[str]]:
    return {
        "podman": [
            "sudo apt update",
            "sudo apt install -y podman",
            "podman --version",
        ],
        "docker": [
            "curl -fsSL https://get.docker.com | sh",
            "sudo usermod -aG docker $USER",
            "docker --version",
        ],
        "coolify": [
            "curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash",
            "docker ps | grep coolify",
        ],
        "tailscale": [
            "curl -fsSL https://tailscale.com/install.sh | sh",
            "sudo tailscale up",
            "tailscale ip -4",
        ],
        "cloudflared": [
            (
                "curl -L https://github.com/cloudflare/cloudflared/"
                "releases/latest/download/cloudflared-linux-amd64.deb "
                "-o cloudflared.deb"
            ),
            "sudo dpkg -i cloudflared.deb",
            "cloudflared --version",
        ],
        "nginx": [
            "sudo apt update",
            "sudo apt install -y nginx",
            "sudo systemctl enable --now nginx",
            "nginx -v",
        ],
    }


def _run_cmd(
    command: list[str], timeout: int = 10
) -> tuple[bool, str, str, int]:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(ROOT_DIR),
            check=False,
        )
        return (
            result.returncode == 0,
            result.stdout.strip(),
            result.stderr.strip(),
            result.returncode,
        )
    except FileNotFoundError:
        return False, "", f"Command not found: {command[0]}", 127
    except subprocess.TimeoutExpired:
        return False, "", "Command timed out", 124


def _read_pid() -> int | None:
    if not PID_FILE.exists():
        return None
    try:
        return int(PID_FILE.read_text(encoding="utf-8").strip())
    except ValueError:
        return None


def _is_pid_running(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _podman_status() -> dict[str, Any]:
    installed, version_out, _, _ = _run_cmd(["podman", "--version"], timeout=5)
    if not installed:
        return {
            "installed": False,
            "version": None,
            "running_containers": 0,
            "sample_containers": [],
        }

    ps_ok, ps_out, _, _ = _run_cmd(
        ["podman", "ps", "--format", "json"], timeout=10
    )
    containers = []
    if ps_ok and ps_out:
        try:
            containers = json.loads(ps_out)
        except json.JSONDecodeError:
            containers = []

    sample = []
    for row in containers[:5]:
        names = row.get("Names") or []
        sample.append(
            {
                "name": names[0] if names else row.get("Id", "unknown")[:12],
                "image": row.get("Image", "unknown"),
                "state": row.get("State", "unknown"),
            }
        )

    return {
        "installed": True,
        "version": version_out,
        "running_containers": len(containers),
        "sample_containers": sample,
    }


def _systemd_status(service_name: str) -> str:
    ok, out, _, code = _run_cmd(
        ["systemctl", "is-active", service_name], timeout=5
    )
    if ok:
        return out or "active"
    if code == 127:
        return "unavailable"
    return out or "inactive"


def _background_status() -> dict[str, Any]:
    pid = _read_pid()
    running = _is_pid_running(pid)
    if not running and PID_FILE.exists():
        PID_FILE.unlink(missing_ok=True)

    log_tail = ""
    if LOG_FILE.exists():
        lines = LOG_FILE.read_text(
            encoding="utf-8", errors="ignore"
        ).splitlines()
        log_tail = "\n".join(lines[-8:])

    return {
        "running": running,
        "pid": pid if running else None,
        "pid_file": str(PID_FILE),
        "log_file": str(LOG_FILE),
        "log_tail": log_tail,
    }


@router.get("/status")
async def runtime_status(_current_user: dict = Depends(util.get_current_user)):
    """Summarize local Podman and WatchTower runtime health."""
    podman = _podman_status()
    watchtower_cmd_ok, _, watchtower_cmd_err, _ = _run_cmd(
        [sys.executable, "-m", "watchtower", "--help"], timeout=10
    )

    return {
        "podman": podman,
        "watchtower": {
            "cli_available": watchtower_cmd_ok,
            "cli_error": None if watchtower_cmd_ok else watchtower_cmd_err,
            "systemd_service": _systemd_status("watchtower.service"),
            "appcenter_service": _systemd_status(
                "watchtower-appcenter.service"
            ),
            "background_process": _background_status(),
        },
    }


@router.post("/watchtower/start-background")
async def start_watchtower_background(
    _current_user: dict = Depends(util.get_current_user)
):
    """Start WatchTower updater loop as a detached background process."""
    DEV_DIR.mkdir(parents=True, exist_ok=True)

    existing_pid = _read_pid()
    if _is_pid_running(existing_pid):
        return {
            "status": "already_running",
            "message": (
                "WatchTower background process is already running "
                f"(PID {existing_pid})."
            ),
            "pid": existing_pid,
            "log_file": str(LOG_FILE),
        }

    with LOG_FILE.open("a", encoding="utf-8") as log_file:
        process = subprocess.Popen(  # noqa: S603
            [sys.executable, "-m", "watchtower", "start"],
            cwd=str(ROOT_DIR),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env={
                **os.environ,
                "PYTHONUNBUFFERED": "1",
            },
        )

    PID_FILE.write_text(str(process.pid), encoding="utf-8")
    time.sleep(0.8)

    if not _is_pid_running(process.pid):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "WatchTower background process failed to start. "
                f"Check log at {LOG_FILE}"
            ),
        )

    return {
        "status": "started",
        "message": "WatchTower background process started.",
        "pid": process.pid,
        "log_file": str(LOG_FILE),
    }


@router.post("/watchtower/stop-background")
async def stop_watchtower_background(
    _current_user: dict = Depends(util.get_current_user)
):
    """Stop detached WatchTower updater process started by the runtime API."""
    pid = _read_pid()
    if not _is_pid_running(pid):
        PID_FILE.unlink(missing_ok=True)
        return {
            "status": "not_running",
            "message": "WatchTower background process is not running.",
        }

    os.kill(pid, signal.SIGTERM)
    time.sleep(0.4)
    still_running = _is_pid_running(pid)
    if still_running:
        os.kill(pid, signal.SIGKILL)

    PID_FILE.unlink(missing_ok=True)

    return {
        "status": "stopped",
        "message": "WatchTower background process stopped.",
        "pid": pid,
    }


@router.post("/watchtower/update-now")
async def watchtower_update_now(
    _current_user: dict = Depends(util.get_current_user)
):
    """Run one immediate WatchTower update check and return command output."""
    ok, out, err, code = _run_cmd(
        [sys.executable, "-m", "watchtower", "update-now"], timeout=120
    )
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "message": "Update check failed",
                "exit_code": code,
                "stderr": err,
                "stdout": out,
            },
        )

    return {
        "status": "ok",
        "message": "Update check completed.",
        "stdout": out,
    }


@router.get("/integrations/status")
async def integrations_status(
    _current_user: dict = Depends(util.get_current_user),
):
    """Return host integration readiness for team onboarding."""
    return {
        "podman": _podman_status(),
        "docker": _docker_status(),
        "coolify": _coolify_status(),
        "tailscale": _tailscale_status(),
        "cloudflared": _cloudflared_status(),
        "nginx": _nginx_status(),
    }


@router.get("/integrations/install-commands")
async def integrations_install_commands(
    _current_user: dict = Depends(util.get_current_user),
):
    """Return copy-ready install commands for each supported integration."""
    return {
        "os": "linux",
        "commands": _linux_install_commands(),
    }


@router.post("/integrations/domain/connect")
async def integrations_domain_connect(
    payload: DomainConnectRequest,
    _current_user: dict = Depends(util.get_current_user),
):
    """Return guided Cloudflare tunnel commands for a domain/subdomain."""
    domain = payload.domain.strip().lower()
    subdomain = payload.subdomain.strip().lower()
    target = payload.target_host.strip()

    if "." not in domain:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide a valid domain, for example: example.com",
        )

    hostname = f"{subdomain}.{domain}"
    tunnel_name = f"watchtower-{subdomain}"

    commands = [
        "cloudflared tunnel login",
        f"cloudflared tunnel create {tunnel_name}",
        f"cloudflared tunnel route dns {tunnel_name} {hostname}",
        (
            "cloudflared tunnel run "
            f"--url http://{target} {tunnel_name}"
        ),
    ]

    return {
        "hostname": hostname,
        "tunnel_name": tunnel_name,
        "target_host": target,
        "commands": commands,
        "notes": [
            (
                "Run cloudflared on the same machine that can reach "
                "your WatchTower app."
            ),
            (
                "Use Cloudflare Zero Trust dashboard to keep "
                "the tunnel always-on as a service."
            ),
            (
                "For production, point the tunnel URL to your reverse "
                "proxy (for example caddy:80)."
            ),
        ],
    }


@router.post("/integrations/database/plan")
async def integration_database_plan(
    payload: DatabasePlanRequest,
    _current_user: dict = Depends(util.get_current_user),
):
    """Return guided setup plan for supported managed database providers."""
    return _database_plan(payload)


@router.post("/integrations/nginx/config")
async def integration_nginx_config(
    payload: NginxConfigRequest,
    _current_user: dict = Depends(util.get_current_user),
):
    """Return sample Nginx reverse proxy config and setup steps."""
    return {
        "server_name": payload.server_name.strip(),
        "upstream_host": payload.upstream_host.strip(),
        "config": _nginx_proxy_config(payload),
        "steps": [
            "Save config under /etc/nginx/sites-available/watchtower.conf",
            "ln -s to sites-enabled and remove default site if needed",
            "Run nginx -t and reload with systemctl reload nginx",
        ],
    }


@router.get("/integrations/vscode/status")
async def vscode_status(
    _current_user: dict = Depends(util.get_current_user),
):
    """Return VS Code CLI availability and host root directory."""
    installed = _command_exists("code")
    version: str | None = None
    if installed:
        ok, out, _, _ = _run_cmd(["code", "--version"], timeout=5)
        if ok and out.strip():
            version = out.strip().splitlines()[0]
    return {
        "installed": installed,
        "version": version,
        "root_dir": str(ROOT_DIR),
        "install_instructions": {
            "linux": (
                "Download VS Code from https://code.visualstudio.com/download "
                "or install via: sudo snap install --classic code"
            ),
            "macos": (
                "Download VS Code from https://code.visualstudio.com/download. "
                "Then open VS Code → Command Palette → 'Shell Command: Install code in PATH'"
            ),
            "windows": "Download VS Code from https://code.visualstudio.com/download",
        },
    }


@router.post("/integrations/vscode/open")
async def vscode_open(
    payload: VSCodeOpenRequest,
    _current_user: dict = Depends(util.get_current_user),
):
    """Open a directory or file in VS Code via the `code` CLI on the server."""
    path = Path(payload.path.strip()).expanduser().resolve()
    if not path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Path not found: {path}",
        )
    if not _command_exists("code"):
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=(
                "VS Code CLI (`code`) is not installed on this host. "
                "Install VS Code and run 'Shell Command: Install code in PATH'."
            ),
        )
    ok, _, err, _ = _run_cmd(["code", str(path)], timeout=10)
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=err or "Failed to launch VS Code.",
        )
    return {"opened": str(path)}




def _podman_watchdog_status() -> dict[str, Any]:
    """Return whether the Podman auto-restart watchdog is enabled."""
    restart_state = _systemd_status("podman-restart.service")
    enabled_ok, enabled_out, _, _ = _run_cmd(
        ["systemctl", "is-enabled", "podman-restart.service"], timeout=5
    )
    return {
        "service": "podman-restart.service",
        "active": restart_state == "active",
        "enabled": enabled_ok and enabled_out.strip() in ("enabled", "enabled-runtime"),
        "state": restart_state,
    }


@router.get("/podman/watchdog")
async def get_podman_watchdog(
    _current_user: dict = Depends(util.get_current_user),
):
    """Return Podman watchdog (auto-restart on boot) status."""
    return _podman_watchdog_status()


@router.post("/podman/watchdog/enable")
async def enable_podman_watchdog(
    _current_user: dict = Depends(util.get_current_user),
):
    """Enable podman-restart.service so Podman containers auto-restart on boot.

    Containers must be started with ``--restart=always`` (or ``on-failure``)
    for the service to restart them.  This call also starts the service now.
    """
    ok_enable, _, err_enable, _ = _run_cmd(
        ["sudo", "-n", "systemctl", "enable", "--now", "podman-restart.service"],
        timeout=15,
    )
    if not ok_enable:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "Failed to enable podman-restart.service. "
                f"Ensure sudo privileges: {err_enable}"
            ),
        )
    return {
        "status": "enabled",
        "message": (
            "podman-restart.service is now enabled and active. "
            "Containers started with --restart=always will auto-restart on boot."
        ),
        "watchdog": _podman_watchdog_status(),
    }


@router.post("/podman/watchdog/disable")
async def disable_podman_watchdog(
    _current_user: dict = Depends(util.get_current_user),
):
    """Disable the Podman watchdog service."""
    ok, _, err, _ = _run_cmd(
        ["sudo", "-n", "systemctl", "disable", "--now", "podman-restart.service"],
        timeout=15,
    )
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                f"Failed to disable podman-restart.service: {err}"
            ),
        )
    return {
        "status": "disabled",
        "message": "podman-restart.service disabled. Containers will not auto-restart on boot.",
        "watchdog": _podman_watchdog_status(),
    }


@router.get("/terminal/policy")
async def terminal_policy(
    _current_user: dict = Depends(util.get_current_user),
):
    """Expose safe terminal execution policy for the UI."""
    return {
        "enabled": bool(os.getenv("WATCHTOWER_TERMINAL_AUDIT_KEY", "").strip()),
        "encryption_required": True,
        "audit_log": str(TERMINAL_AUDIT_FILE),
        "max_timeout_seconds": 120,
        "allowed_commands": [
            {
                "command": name,
                "allow_sudo": cfg["allow_sudo"],
                "must_sudo": cfg["must_sudo"],
            }
            for name, cfg in sorted(TERMINAL_ALLOWED_COMMANDS.items())
        ],
    }


@router.post("/terminal/execute")
async def terminal_execute(
    payload: TerminalCommandRequest,
    _current_user: dict = Depends(util.get_current_user),
):
    """Execute an allow-listed terminal command with encrypted auditing."""
    user_id = str(_current_user.get("id", "unknown"))
    return _execute_terminal_command(payload, user_id=user_id)


# ── Service control ───────────────────────────────────────────────────────────

ALLOWED_ACTIONS = frozenset({"start", "stop", "restart", "enable", "disable"})

# Maps public service name → control strategy
_SERVICE_MAP: dict[str, dict[str, Any]] = {
    "nginx": {
        "type": "systemd",
        "unit": "nginx.service",
        "actions": {"start", "stop", "restart", "enable", "disable"},
    },
    "tailscale": {
        "type": "hybrid",
        "unit": "tailscaled.service",
        # start/stop use the tailscale CLI; enable/disable use systemd
        "start_cmd": ["tailscale", "up"],
        "stop_cmd": ["tailscale", "down"],
        "actions": {"start", "stop", "enable", "disable"},
    },
    "cloudflared": {
        "type": "systemd",
        "unit": "cloudflared.service",
        "actions": {"start", "stop", "restart", "enable", "disable"},
    },
    "podman": {
        "type": "systemd",
        "unit": "podman.socket",
        "actions": {"start", "stop", "restart", "enable", "disable"},
    },
    "docker": {
        "type": "systemd",
        "unit": "docker.service",
        "actions": {"start", "stop", "restart", "enable", "disable"},
    },
    "coolify": {
        "type": "docker_container",
        "container": "coolify",
        "actions": {"start", "stop", "restart"},
    },
}


class ServiceControlRequest(BaseModel):
    action: str = Field(description="start | stop | restart | enable | disable")


def _control_systemd(unit: str, action: str) -> tuple[bool, str]:
    """Run a sudo systemctl action against a unit and return (ok, message)."""
    ok, _, err, _ = _run_cmd(
        ["sudo", "-n", "systemctl", action, unit], timeout=20
    )
    if ok:
        return True, f"{unit}: {action} succeeded."
    return False, err or f"systemctl {action} {unit} failed."


def _do_service_control(service: str, action: str) -> dict[str, Any]:
    cfg = _SERVICE_MAP[service]
    allowed = cfg["actions"]

    if action not in allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Action '{action}' is not supported for '{service}'. "
                f"Allowed: {sorted(allowed)}"
            ),
        )

    svc_type = cfg["type"]

    if svc_type == "systemd":
        ok, msg = _control_systemd(cfg["unit"], action)

    elif svc_type == "hybrid":
        # start/stop: use native CLI; enable/disable: use systemd
        if action == "start":
            cmd = cfg["start_cmd"]
            ok, _, err, _ = _run_cmd(cmd, timeout=20)
            msg = f"tailscale up succeeded." if ok else (err or "tailscale up failed.")
        elif action == "stop":
            cmd = cfg["stop_cmd"]
            ok, _, err, _ = _run_cmd(cmd, timeout=20)
            msg = "tailscale down succeeded." if ok else (err or "tailscale down failed.")
        else:
            ok, msg = _control_systemd(cfg["unit"], action)

    elif svc_type == "docker_container":
        container = cfg["container"]
        ok, _, err, _ = _run_cmd(["docker", action, container], timeout=20)
        msg = f"docker {action} {container} succeeded." if ok else (err or f"docker {action} failed.")

    else:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unknown service type for '{service}'.",
        )

    if not ok:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=msg,
        )

    return {"service": service, "action": action, "ok": True, "message": msg}


@router.post("/services/{service}/control")
async def service_control(
    service: str,
    payload: ServiceControlRequest,
    _current_user: dict = Depends(util.get_current_user),
):
    """Start, stop, restart, enable or disable an integration service.

    Supported services: nginx, tailscale, cloudflared, podman, docker, coolify.
    Supported actions: start, stop, restart, enable, disable (per service).
    """
    if service not in _SERVICE_MAP:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                f"Unknown service '{service}'. "
                f"Supported: {sorted(_SERVICE_MAP)}"
            ),
        )

    action = payload.action.strip().lower()
    if action not in ALLOWED_ACTIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Invalid action '{action}'. "
                f"Allowed: {sorted(ALLOWED_ACTIONS)}"
            ),
        )

    return _do_service_control(service, action)


# ── Update check (GitHub Releases) ──────────────────────────────────────────
# The desktop wrapper has electron-updater, but browser-mode users (and
# self-hosted operators) need a way to see "your version is out of date" too.
# This endpoint queries the public GitHub Releases API and caches the result
# for an hour to stay well under the 60-req/hr unauthenticated rate limit.

_GITHUB_RELEASES_URL = (
    "https://api.github.com/repos/sinhaankur/WatchTower/releases/latest"
)
_UPDATE_CACHE_TTL_SEC = 3600  # 1 hour
_update_cache: dict[str, Any] = {"value": None, "fetched_at": 0.0}
_update_cache_lock = threading.Lock()


def _normalize_version(tag: str) -> str:
    """Strip a leading ``v`` from a GitHub tag like ``v1.4.0`` → ``1.4.0``."""
    return tag[1:] if tag.startswith("v") else tag


def _parse_semver(v: str) -> tuple[int, ...] | None:
    """Coarse semver parse — returns (major, minor, patch) or None if it
    doesn't look like a numeric semver. Pre-release suffixes (``-rc.1``)
    drop to the numeric prefix so a release of ``1.5.0-rc.1`` is still
    treated as 1.5.0 for ordering vs an installed ``1.4.0``."""
    base = v.split("-", 1)[0].split("+", 1)[0]
    parts = base.split(".")
    try:
        return tuple(int(p) for p in parts[:3])
    except ValueError:
        return None


def _fetch_latest_release() -> dict[str, Any] | None:
    try:
        resp = requests.get(
            _GITHUB_RELEASES_URL,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": f"WatchTower/{watchtower.__version__}",
            },
            timeout=5,
        )
    except requests.RequestException as exc:
        logger.info("Update check: GitHub request failed: %s", exc)
        return None
    if resp.status_code != 200:
        logger.info("Update check: GitHub returned %s", resp.status_code)
        return None
    try:
        body = resp.json()
    except ValueError:
        return None
    tag = body.get("tag_name")
    if not isinstance(tag, str) or not tag:
        return None
    return {
        "latest": _normalize_version(tag),
        "tag_name": tag,
        "release_url": body.get("html_url"),
        "published_at": body.get("published_at"),
        "name": body.get("name") or tag,
    }


def _check_for_update(force: bool = False) -> dict[str, Any]:
    current = watchtower.__version__
    now = time.time()
    with _update_cache_lock:
        cached = _update_cache["value"]
        fresh = (now - _update_cache["fetched_at"]) < _UPDATE_CACHE_TTL_SEC
        if cached and fresh and not force:
            latest_info: dict[str, Any] | None = cached
        else:
            latest_info = _fetch_latest_release()
            if latest_info:
                _update_cache["value"] = latest_info
                _update_cache["fetched_at"] = now
            elif not cached:
                # Fetch failed and we have nothing — return a degraded
                # response rather than 5xx so the UI can show "couldn't
                # check" without being noisy.
                return {
                    "current": current,
                    "latest": None,
                    "has_update": False,
                    "release_url": None,
                    "published_at": None,
                    "checked_at": datetime.now(timezone.utc).isoformat(),
                    "error": "Could not reach GitHub to check for updates.",
                }
            else:
                latest_info = cached  # use stale cache on transient failure

    has_update = False
    if latest_info:
        cur = _parse_semver(current)
        latest = _parse_semver(latest_info["latest"])
        if cur is not None and latest is not None:
            has_update = latest > cur
        else:
            has_update = latest_info["latest"] != current

    return {
        "current": current,
        "latest": latest_info["latest"] if latest_info else None,
        "has_update": has_update,
        "release_url": latest_info.get("release_url") if latest_info else None,
        "published_at": (
            latest_info.get("published_at") if latest_info else None
        ),
        "release_name": latest_info.get("name") if latest_info else None,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/version")
async def runtime_version(
    force: bool = False,
    _current_user: dict = Depends(util.get_current_user),
):
    """Report the running version and whether a newer GitHub release exists.

    Pass ``?force=true`` to bypass the in-process cache (used by the
    Settings "Check for Updates" button so the user gets a live answer).
    """
    return _check_for_update(force=force)


# ── Local node auto-config ──────────────────────────────────────────────────
# Powers the "Use This PC as a Server" LocalNode page. Without this, users
# have to know off the top of their head: which deploy path to use, the
# right reload command for their init system, the right profile for their
# hardware. The existing form has *some* defaults (per-OS deploy path) but
# everything else is blank. This endpoint probes the local host and
# returns a fully-pre-filled config so the user just clicks "Register".

import platform as _platform
import socket as _socket


def _detect_local_profile() -> dict:
    """Light/Standard/Full based on detected CPU + RAM."""
    try:
        cpus = os.cpu_count() or 1
    except Exception:
        cpus = 1
    ram_gb = 0
    try:
        # /proc/meminfo on Linux; falls back gracefully on macOS/Windows.
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    ram_gb = int(line.split()[1]) / (1024 * 1024)
                    break
    except (OSError, ValueError):
        pass

    if cpus >= 4 and ram_gb >= 4:
        chosen = "full"
        concurrency = 4
    elif cpus >= 2 and ram_gb >= 2:
        chosen = "standard"
        concurrency = 2
    else:
        chosen = "light"
        concurrency = 1
    return {
        "id": chosen,
        "concurrency": concurrency,
        "detected_cpus": cpus,
        "detected_ram_gb": round(ram_gb, 1),
    }


def _detect_reload_command(detected: dict[str, dict]) -> str:
    """Pick the most appropriate reload command from what's installed."""
    # Prefer Podman if installed (project's primary container runtime).
    if detected.get("podman", {}).get("installed"):
        return "systemctl --user restart watchtower-agent.service || podman generate kube"
    if detected.get("docker", {}).get("installed"):
        return "sudo systemctl restart docker || docker compose restart"
    # Fall back to a generic systemd unit name; harmless if the unit
    # doesn't exist — the deployer will just get a clean error.
    return "sudo systemctl restart watchtower-agent"


def _detect_deploy_path(os_type: str) -> str:
    if os_type == "windows":
        return "C:\\WatchTower\\agent"
    if os_type == "darwin":
        return "/usr/local/var/watchtower/agent"
    # Linux / other Unix
    return os.path.join(os.path.expanduser("~"), ".watchtower", "agent")


def _suggest_node_name() -> str:
    try:
        host = _socket.gethostname() or "this-pc"
    except Exception:
        host = "this-pc"
    return f"{host}-local"


@router.get("/local-node/suggest-config")
async def local_node_suggest_config(
    _current_user: dict = Depends(util.get_current_user),
):
    """Return a fully-pre-filled "Use This PC as a Server" config.

    The LocalNode page calls this on mount and uses every field as the
    default form value. Probes the local host in two ways:
      * `_detect_local_profile()` → resource-class (Light/Standard/Full)
      * `_podman_status()` / `_docker_status()` → container runtime →
        appropriate reload command
    Anything the probe can't determine falls back to a sensible default.
    """
    os_type = _platform.system().lower()  # 'linux' | 'darwin' | 'windows'
    detected = {
        "podman": _podman_status(),
        "docker": _docker_status(),
    }
    profile = _detect_local_profile()
    return {
        "os_type": os_type,
        "node_name": _suggest_node_name(),
        "deploy_path": _detect_deploy_path(os_type),
        "user": "SYSTEM" if os_type == "windows" else os.getenv("USER", "watchtower"),
        "host": "127.0.0.1",
        "port": 22,
        # SSH key isn't actually used for the local-loopback case but the
        # OrgNode model still requires the field. Send a sentinel that
        # clearly signals "not used" rather than a believable-looking
        # path that would confuse anyone debugging later.
        "ssh_key_path": "none" if os_type == "windows" else "~/.ssh/id_rsa",
        "reload_command": _detect_reload_command(detected),
        "profile_id": profile["id"],
        "max_concurrent_deployments": profile["concurrency"],
        "is_primary": True,
        "detected": {
            "podman_installed": detected["podman"].get("installed", False),
            "docker_installed": detected["docker"].get("installed", False),
            "cpus": profile["detected_cpus"],
            "ram_gb": profile["detected_ram_gb"],
        },
    }
