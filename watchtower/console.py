"""WatchTower interactive console — a REPL for ops over the running API.

Why a console, not just the CLI: the argparse CLIs (`watchtower`,
`watchtower-deploy`) are one-shot commands. This is a stay-open shell for
"poke at the running system" sessions — list projects, watch deployments,
kick a deploy, roll one back — without re-typing curl/token boilerplate each
time. Same audience as the VS Code extension, but for people who live in a
terminal / SSH into the box.

Architectural choice mirrors the MCP server: a **thin HTTP client over the
existing /api surface**, never direct DB access. Every action goes through
the same auth + RBAC + audit-log + rate-limit middleware the SPA uses, so the
console can only do what its token can do — no new privilege path.

Dependency-free on purpose: stdlib ``input`` + ``requests`` (a core dep) +
ANSI colours. No rich/textual/prompt_toolkit, so it works in a bare SSH
session and keeps the lean-packaging promise (see pyproject extras).

Config (same env conventions as the MCP server + deploy script):
    WATCHTOWER_API_BASE_URL   default http://127.0.0.1:8000
    WATCHTOWER_API_TOKEN      the bearer token (dev default works locally)

Launch:
    watchtower-console
    watchtower-console --base-url http://host:8000 --token <tok>
    watchtower-console status          # one-shot: run a command and exit
"""
from __future__ import annotations

import argparse
import os
import shlex
import sys
from typing import Optional

import requests


# ── Colours (disabled when not a TTY or NO_COLOR set) ────────────────────────

class _C:
    def __init__(self, enabled: bool):
        self.enabled = enabled

    def _w(self, code: str, s: str) -> str:
        return f"\033[{code}m{s}\033[0m" if self.enabled else s

    def bold(self, s): return self._w("1", s)
    def dim(self, s): return self._w("2", s)
    def green(self, s): return self._w("32", s)
    def red(self, s): return self._w("31", s)
    def yellow(self, s): return self._w("33", s)
    def cyan(self, s): return self._w("36", s)


def _status_colour(c: _C, status: str) -> str:
    s = (status or "").lower()
    if s in ("live", "success", "healthy", "deployed"):
        return c.green(status)
    if s in ("failed", "error", "unhealthy"):
        return c.red(status)
    if s in ("building", "deploying", "pending", "running", "queued"):
        return c.yellow(status)
    return status


# ── HTTP client ──────────────────────────────────────────────────────────────

class ConsoleApiError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


class ConsoleClient:
    def __init__(self, base_url: str, token: Optional[str], timeout: float = 15.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _headers(self) -> dict:
        h = {"Accept": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def request(self, method: str, path: str, **kwargs):
        url = f"{self.base_url}{path}"
        try:
            resp = requests.request(method, url, headers=self._headers(), timeout=self.timeout, **kwargs)
        except requests.exceptions.ConnectionError:
            # urllib3's ConnectionError str is a wall of pool internals; the
            # console user only needs "can't reach it".
            raise ConsoleApiError(0, f"Could not reach WatchTower at {self.base_url} (connection refused).") from None
        except requests.RequestException as exc:
            raise ConsoleApiError(0, f"Could not reach WatchTower at {self.base_url}: {exc}") from exc
        if resp.status_code >= 400:
            detail = resp.text[:300]
            try:
                body = resp.json()
                detail = body.get("detail", detail) if isinstance(body, dict) else detail
            except ValueError:
                pass
            raise ConsoleApiError(resp.status_code, str(detail))
        if resp.status_code == 204 or not resp.content:
            return None
        try:
            return resp.json()
        except ValueError:
            return resp.text

    def get(self, path, **kw): return self.request("GET", path, **kw)
    def post(self, path, **kw): return self.request("POST", path, **kw)


# ── Command implementations ──────────────────────────────────────────────────

class Console:
    def __init__(self, client: ConsoleClient, colour: _C):
        self.client = client
        self.c = colour
        # Cache of project name → id so commands can take a friendly name.
        self._projects_cache: dict[str, str] = {}

    # --- helpers ---
    def _refresh_projects(self) -> list[dict]:
        projects = self.client.get("/api/projects") or []
        self._projects_cache = {p["name"]: p["id"] for p in projects}
        return projects

    def _resolve_project_id(self, ref: str) -> str:
        """Accept a project name or a UUID."""
        if ref in self._projects_cache:
            return self._projects_cache[ref]
        # Refresh once in case the cache is cold/stale.
        self._refresh_projects()
        if ref in self._projects_cache:
            return self._projects_cache[ref]
        # Assume it's already an id.
        return ref

    # --- commands ---
    def cmd_health(self, _args):
        h = self.client.get("/health")
        r = self.client.get("/ready")
        print(f"  liveness : {_status_colour(self.c, h.get('status', '?'))}")
        db = r.get("database", "?") if isinstance(r, dict) else "?"
        print(f"  readiness: {_status_colour(self.c, r.get('status', '?'))}  (database: {db})")

    def cmd_whoami(self, _args):
        me = self.client.get("/api/me")
        print(f"  {self.c.bold(me.get('name') or me.get('email') or 'unknown')}")
        if me.get("email"):
            print(f"  {self.c.dim(me['email'])}")

    def cmd_projects(self, _args):
        projects = self._refresh_projects()
        if not projects:
            print(self.c.dim("  No projects yet."))
            return
        print(f"  {self.c.bold('NAME'):<32} {self.c.bold('BRANCH'):<16} ACTIVE")
        for p in projects:
            active = self.c.green("yes") if p.get("is_active") else self.c.dim("no")
            print(f"  {p['name']:<24} {str(p.get('repo_branch', '')):<16} {active}")

    def cmd_deployments(self, args):
        if not args:
            print(self.c.red("  usage: deployments <project-name-or-id>"))
            return
        pid = self._resolve_project_id(args[0])
        deps = self.client.get(f"/api/projects/{pid}/deployments") or []
        if not deps:
            print(self.c.dim("  No deployments for this project."))
            return
        print(f"  {'STATUS':<12} {'BRANCH':<14} {'WHEN':<20} COMMIT")
        for d in deps[:15]:
            when = (d.get("created_at") or "")[:19].replace("T", " ")
            sha = (d.get("commit_sha") or "")[:8]
            print(f"  {_status_colour(self.c, d.get('status','?')):<20} "
                  f"{str(d.get('branch',''))[:14]:<14} {when:<20} {sha}")

    def cmd_deploy(self, args):
        if not args:
            print(self.c.red("  usage: deploy <project-name-or-id> [branch]"))
            return
        pid = self._resolve_project_id(args[0])
        branch = args[1] if len(args) > 1 else "main"
        result = self.client.post(f"/api/projects/{pid}/deployments", json={"branch": branch})
        print(f"  {self.c.green('✓ deployment queued')} "
              f"{self.c.dim('#' + str(result.get('id', ''))[:8])} on branch {branch}")

    def cmd_rollback(self, args):
        if not args:
            print(self.c.red("  usage: rollback <deployment-id>"))
            return
        result = self.client.post(f"/api/deployments/{args[0]}/rollback")
        print(f"  {self.c.green('✓ rollback triggered')} → new deployment "
              f"{self.c.dim('#' + str(result.get('id',''))[:8])}")

    def cmd_help(self, _args):
        print(self.c.bold("  Commands:"))
        for name, desc in _COMMANDS_HELP:
            print(f"    {self.c.cyan(name):<28} {self.c.dim(desc)}")

    # --- dispatch ---
    def run_command(self, line: str) -> bool:
        """Execute one command line. Returns False to signal exit."""
        try:
            parts = shlex.split(line)
        except ValueError as exc:
            print(self.c.red(f"  parse error: {exc}"))
            return True
        if not parts:
            return True
        cmd, args = parts[0].lower(), parts[1:]

        if cmd in ("quit", "exit", "q"):
            return False
        handler = {
            "health": self.cmd_health,
            "whoami": self.cmd_whoami,
            "projects": self.cmd_projects,
            "ls": self.cmd_projects,
            "deployments": self.cmd_deployments,
            "deploys": self.cmd_deployments,
            "deploy": self.cmd_deploy,
            "rollback": self.cmd_rollback,
            "help": self.cmd_help,
            "?": self.cmd_help,
        }.get(cmd)

        if not handler:
            print(self.c.red(f"  unknown command: {cmd}") + self.c.dim("  (type 'help')"))
            return True
        try:
            handler(args)
        except ConsoleApiError as exc:
            if exc.status == 401:
                print(self.c.red("  401 Unauthorized — check WATCHTOWER_API_TOKEN."))
            elif exc.status == 0:
                print(self.c.red(f"  {exc.detail}"))
            else:
                print(self.c.red(f"  API error {exc.status}: {exc.detail}"))
        return True


_COMMANDS_HELP = [
    ("health", "liveness + readiness (DB) of the backend"),
    ("whoami", "the identity behind the current token"),
    ("projects | ls", "list projects"),
    ("deployments <proj>", "recent deployments for a project"),
    ("deploy <proj> [branch]", "queue a deployment (default branch: main)"),
    ("rollback <deploy-id>", "roll a deployment back"),
    ("help | ?", "this help"),
    ("quit | exit | q", "leave the console"),
]


def _banner(c: _C, base_url: str) -> str:
    return (
        c.bold("WatchTower console") + c.dim(f"  →  {base_url}") + "\n"
        + c.dim("Type 'help' for commands, 'quit' to exit.")
    )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="watchtower-console",
        description="Interactive console for a running WatchTower API.",
    )
    parser.add_argument("--base-url", default=os.getenv("WATCHTOWER_API_BASE_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--token", default=os.getenv("WATCHTOWER_API_TOKEN") or os.getenv("WATCHTOWER_TOKEN"))
    parser.add_argument("--no-color", action="store_true", help="Disable ANSI colours.")
    parser.add_argument("command", nargs="*", help="Run a single command then exit (non-interactive).")
    args = parser.parse_args(argv)

    colour_enabled = (not args.no_color) and sys.stdout.isatty() and not os.getenv("NO_COLOR")
    c = _C(colour_enabled)
    client = ConsoleClient(args.base_url, args.token)
    console = Console(client, c)

    # One-shot mode: `watchtower-console status` etc.
    if args.command:
        console.run_command(" ".join(args.command))
        return 0

    print(_banner(c, args.base_url))
    # Fail fast with a friendly message if the API isn't reachable at all.
    try:
        client.get("/health")
    except ConsoleApiError as exc:
        print(c.red(f"\n  ⚠ {exc.detail}"))
        print(c.dim("  Is the backend running?  Try: watchtower-deploy serve  (or ./run.sh)"))
        # Still drop into the REPL — the server might come up mid-session.

    while True:
        try:
            line = input(c.cyan("watchtower› "))
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not console.run_command(line):
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
