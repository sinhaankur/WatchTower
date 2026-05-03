#!/usr/bin/env python3
"""Watchtower deployment orchestrator for Ubuntu servers.

Features:
- FastAPI listener to trigger deployments via webhook/CLI call
- Pull latest code from Git
- Distribute files to SSH nodes via rsync
- Run reload commands remotely over SSH
"""

from __future__ import annotations

import argparse
import hmac
import json
import logging
import os
import subprocess
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fabric import Connection
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from watchtower.log_config import setup_logging

# Idempotent — if the FastAPI app already set this up, no-op.
setup_logging()
logger = logging.getLogger("watchtower")


DEPLOY_HISTORY: deque[dict[str, Any]] = deque(maxlen=200)


@dataclass
class Node:
    name: str
    host: str
    user: str
    remote_path: str
    reload_command: str
    port: int = 22


class DeployRequest(BaseModel):
    branch: str = Field(default=os.getenv("WATCHTOWER_DEFAULT_BRANCH", "main"))
    source_path: str | None = None


class AppDeployRequest(BaseModel):
    branch: str | None = None


def append_history(
    *,
    deployment_type: str,
    app_name: str,
    branch: str,
    status: str,
    message: str,
) -> None:
    DEPLOY_HISTORY.appendleft(
        {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "type": deployment_type,
            "app": app_name,
            "branch": branch,
            "status": status,
            "message": message,
        }
    )


def run_cmd(
    cmd: list[str], *, check: bool = True
) -> subprocess.CompletedProcess[str]:
    logger.info("Executing: %s", " ".join(cmd))
    return subprocess.run(cmd, text=True, capture_output=True, check=check)


def load_inventory(inventory_path: Path) -> tuple[list[Node], str | None]:
    with inventory_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    ssh_key = data.get("ssh_key")
    raw_nodes = data.get("nodes", [])
    nodes: list[Node] = []

    for item in raw_nodes:
        try:
            node = Node(
                name=item["name"],
                host=item["host"],
                user=item["user"],
                port=int(item.get("port", 22)),
                remote_path=item["remote_path"],
                reload_command=item["reload_command"],
            )
        except KeyError as exc:
            raise ValueError(f"Missing key in nodes.json: {exc}") from exc
        nodes.append(node)

    return nodes, ssh_key


def load_apps_registry(apps_path: Path) -> dict[str, Any]:
    with apps_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    apps = data.get("apps", [])
    if not isinstance(apps, list):
        raise ValueError("apps.json must contain an 'apps' list")

    registry: dict[str, Any] = {}
    for app_item in apps:
        name = app_item.get("name")
        if not name:
            raise ValueError("Each app in apps.json must include 'name'")
        registry[name] = app_item

    return registry


def git_pull(repo_dir: Path, branch: str) -> dict[str, str]:
    if not repo_dir.exists():
        raise FileNotFoundError(
            f"Repository directory does not exist: {repo_dir}"
        )

    run_cmd(["git", "-C", str(repo_dir), "fetch", "origin", branch])
    run_cmd(["git", "-C", str(repo_dir), "checkout", branch])
    pull_result = run_cmd(
        ["git", "-C", str(repo_dir), "pull", "--ff-only", "origin", branch]
    )

    return {
        "stdout": pull_result.stdout.strip(),
        "stderr": pull_result.stderr.strip(),
    }


def rsync_to_node(source_path: Path, node: Node, ssh_key: str | None) -> None:
    ssh_cmd = ["ssh", "-p", str(node.port)]
    if ssh_key:
        ssh_cmd.extend(["-i", ssh_key])

    rsync_cmd = [
        "rsync",
        "-az",
        "--delete",
        "-e",
        " ".join(ssh_cmd),
        f"{source_path}/",
        f"{node.user}@{node.host}:{node.remote_path.rstrip('/')}/",
    ]
    run_cmd(rsync_cmd)


def build_connection(node: Node, ssh_key: str | None) -> Connection:
    connect_kwargs: dict[str, Any] = {}
    if ssh_key:
        connect_kwargs["key_filename"] = ssh_key

    return Connection(
        host=node.host,
        user=node.user,
        port=node.port,
        connect_kwargs=connect_kwargs,
    )


def reload_node(node: Node, ssh_key: str | None) -> None:
    with build_connection(node, ssh_key) as conn:
        result = conn.run(node.reload_command, hide=True, warn=False)
    if result.failed:
        raise subprocess.CalledProcessError(
            returncode=result.return_code,
            cmd=node.reload_command,
            output=result.stdout,
            stderr=result.stderr,
        )


def deploy(branch: str, source_path: Path | None = None) -> dict[str, Any]:
    repo_dir = Path(os.getenv("WATCHTOWER_REPO_DIR", "/opt/website"))
    inventory_path = Path(os.getenv("WATCHTOWER_NODES_FILE", "./config/nodes.json"))

    return deploy_with_paths(
        branch=branch,
        repo_dir=repo_dir,
        inventory_path=inventory_path,
        source_path=source_path,
    )


def deploy_with_paths(
    branch: str,
    repo_dir: Path,
    inventory_path: Path,
    source_path: Path | None = None,
    git_result: dict[str, str] | None = None,
) -> dict[str, Any]:

    nodes, ssh_key = load_inventory(inventory_path)

    if git_result is None:
        git_result = git_pull(repo_dir, branch)
    deploy_source = source_path if source_path is not None else repo_dir

    if not deploy_source.exists():
        raise FileNotFoundError(
            f"Deployment source path does not exist: {deploy_source}"
        )

    results: list[dict[str, Any]] = []
    for node in nodes:
        node_result: dict[str, Any] = {
            "node": node.name,
            "host": node.host,
            "status": "ok",
        }
        try:
            rsync_to_node(deploy_source, node, ssh_key)
            reload_node(node, ssh_key)
        except subprocess.CalledProcessError as exc:
            node_result["status"] = "failed"
            node_result["error"] = exc.stderr.strip() or exc.stdout.strip()
            logger.error("Node %s failed: %s", node.name, node_result["error"])
        results.append(node_result)

    failures = [r for r in results if r["status"] == "failed"]
    status = "partial_failure" if failures else "success"

    return {
        "status": status,
        "branch": branch,
        "repo_dir": str(repo_dir),
        "inventory_path": str(inventory_path),
        "source_path": str(deploy_source),
        "git": git_result,
        "results": results,
    }


def deploy_registered_app(
    app_name: str, branch: str | None = None
) -> dict[str, Any]:
    apps_path = Path(os.getenv("WATCHTOWER_APPS_FILE", "./config/apps.json"))
    registry = load_apps_registry(apps_path)
    app_config = registry.get(app_name)
    if app_config is None:
        raise ValueError(f"Unknown app '{app_name}' in {apps_path}")

    app_repo_dir = Path(app_config["repo_dir"])
    app_inventory_path = Path(app_config.get("nodes_file", "./config/nodes.json"))
    app_branch = branch or app_config.get(
        "branch", os.getenv("WATCHTOWER_DEFAULT_BRANCH", "main")
    )

    source_subpath = app_config.get("source_subpath")
    source_path: Path | None = None
    if source_subpath:
        source_path = app_repo_dir / str(source_subpath)

    build_command = app_config.get("build_command")
    git_result = git_pull(app_repo_dir, app_branch)
    if build_command:
        # Run optional app build step after git pull.
        run_cmd(["bash", "-lc", f"cd '{app_repo_dir}' && {build_command}"])

    deploy_result = deploy_with_paths(
        branch=app_branch,
        repo_dir=app_repo_dir,
        inventory_path=app_inventory_path,
        source_path=source_path,
        git_result=git_result,
    )
    deploy_result["app"] = app_name
    deploy_result["apps_file"] = str(apps_path)
    deploy_result["git"] = git_result
    return deploy_result


app = FastAPI(title="Watchtower Deployment API", version="1.0.0")


DASHBOARD_HTML = """
<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WatchTower Control Center</title>
    <style>
        :root {
            --bg: #070b14;
            --panel: #0f1628;
            --panel-2: #0c1323;
            --line: #223452;
            --text: #e6ecff;
            --muted: #9dafcd;
            --good: #31d0a2;
            --warn: #ffb84d;
            --bad: #ff7f8e;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: "Segoe UI", "Helvetica Neue", sans-serif;
            background: radial-gradient(circle at 15% 8%, #15264a 0%, var(--bg) 38%);
            color: var(--text);
        }
        .app { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
        .sidebar {
            border-right: 1px solid var(--line);
            background: rgba(6, 10, 18, 0.8);
            padding: 18px;
        }
        .brand { font-weight: 700; margin-bottom: 18px; }
        .nav a {
            display: block;
            text-decoration: none;
            color: var(--muted);
            padding: 10px;
            margin-bottom: 7px;
            border-radius: 10px;
            border: 1px solid transparent;
        }
        .nav a.active, .nav a:hover {
            color: var(--text);
            border-color: var(--line);
            background: var(--panel-2);
        }
        .main { padding: 24px; }
        .toolbar {
            display: flex;
            gap: 10px;
            align-items: center;
            margin-bottom: 16px;
        }
        .toolbar input {
            width: 320px;
            max-width: 50vw;
            background: var(--panel-2);
            border: 1px solid var(--line);
            border-radius: 10px;
            color: var(--text);
            padding: 8px 10px;
        }
        .toolbar button {
            border: 1px solid var(--line);
            background: var(--panel);
            color: var(--text);
            border-radius: 10px;
            padding: 8px 12px;
            cursor: pointer;
        }
        .kpis { display: grid; gap: 12px; grid-template-columns: repeat(3, 1fr); }
        .card {
            border: 1px solid var(--line);
            border-radius: 12px;
            background: var(--panel);
            padding: 14px;
        }
        .label { color: var(--muted); font-size: 0.85rem; }
        .value { margin-top: 8px; font-size: 1.5rem; font-weight: 700; }
        .sections {
            margin-top: 14px;
            display: grid;
            gap: 12px;
            grid-template-columns: 1.35fr 1fr;
        }
        .project-grid { display: grid; gap: 10px; grid-template-columns: repeat(2, 1fr); }
        .project {
            border: 1px solid var(--line);
            border-radius: 12px;
            background: var(--panel-2);
            padding: 12px;
        }
        .project-head {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            gap: 8px;
        }
        .status-ok { color: var(--good); }
        .status-failed { color: var(--bad); }
        .muted { color: var(--muted); }
        .small { font-size: 0.82rem; }
        .project button {
            margin-top: 10px;
            border: 1px solid var(--line);
            background: #13223d;
            color: var(--text);
            border-radius: 10px;
            padding: 7px 10px;
            cursor: pointer;
        }
        .list { margin: 0; padding-left: 18px; }
        .list li { margin-bottom: 8px; }
        @media (max-width: 980px) {
            .app { grid-template-columns: 1fr; }
            .sidebar { display: none; }
            .kpis { grid-template-columns: 1fr; }
            .sections { grid-template-columns: 1fr; }
            .project-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="app">
        <aside class="sidebar">
            <div class="brand">WatchTower Control</div>
            <div class="nav">
                <a class="active" href="#">Overview</a>
                <a href="#">Projects</a>
                <a href="#">Deployments</a>
                <a href="#">Security</a>
                <a href="#">Domains</a>
                <a href="#">Settings</a>
            </div>
        </aside>
        <main class="main">
            <div class="toolbar">
                <input id="token" type="password" placeholder="X-Watchtower-Token" />
                <button onclick="refreshData()">Refresh</button>
            </div>

            <section class="kpis">
                <div class="card"><div class="label">Projects</div><div class="value" id="kpi-projects">0</div></div>
                <div class="card"><div class="label">Nodes</div><div class="value" id="kpi-nodes">0</div></div>
                <div class="card"><div class="label">Deployments (24h)</div><div class="value" id="kpi-deploys">0</div></div>
            </section>

            <section class="sections">
                <div class="card">
                    <h3>Projects</h3>
                    <div id="projects" class="project-grid"></div>
                </div>

                <div class="card">
                    <h3>Recent Deployments</h3>
                    <ul id="recent" class="list"></ul>
                </div>
            </section>
        </main>
    </div>

    <script>
        function statusClass(status) {
            return status === "success" ? "status-ok" : status === "failed" ? "status-failed" : "muted";
        }

        async function request(path, method = "GET", body = null) {
            const token = document.getElementById("token").value.trim();
            const headers = {"Content-Type": "application/json"};
            if (token) headers["X-Watchtower-Token"] = token;
            const res = await fetch(path, {
                method,
                headers,
                body: body ? JSON.stringify(body) : null,
            });
            if (!res.ok) {
                const txt = await res.text();
                throw new Error(txt || "Request failed");
            }
            return res.json();
        }

        async function deployApp(name) {
            try {
                await request(`/apps/${name}/deploy`, "POST", {});
                await refreshData();
            } catch (err) {
                alert(`Deploy failed for ${name}: ${err.message}`);
            }
        }

        function renderProjects(apps) {
            const holder = document.getElementById("projects");
            holder.innerHTML = "";
            apps.forEach((app) => {
                const item = document.createElement("article");
                item.className = "project";
                item.innerHTML = `
                    <div class="project-head">
                        <strong>${app.name}</strong>
                        <span class="small ${statusClass(app.last_status)}">${app.last_status}</span>
                    </div>
                    <div class="small muted">Branch: ${app.branch}</div>
                    <div class="small muted">Repo: ${app.repo_dir}</div>
                    <div class="small muted">Last deploy: ${app.last_deployed_at || "never"}</div>
                    <button data-app="${app.name}">Deploy</button>
                `;
                item.querySelector("button").addEventListener("click", () => deployApp(app.name));
                holder.appendChild(item);
            });
        }

        function renderRecent(rows) {
            const holder = document.getElementById("recent");
            holder.innerHTML = "";
            rows.forEach((row) => {
                const li = document.createElement("li");
                li.className = "small";
                li.innerHTML = `<span class="${statusClass(row.status)}">${row.status}</span> - ${row.app} (${row.branch})`;
                holder.appendChild(li);
            });
        }

        async function refreshData() {
            try {
                const data = await request("/ui/data");
                document.getElementById("kpi-projects").textContent = String(data.usage.total_apps);
                document.getElementById("kpi-nodes").textContent = String(data.usage.total_nodes);
                document.getElementById("kpi-deploys").textContent = String(data.usage.deployments_24h);
                renderProjects(data.apps);
                renderRecent(data.recent_deployments);
            } catch (err) {
                alert(`Unable to load dashboard data: ${err.message}`);
            }
        }

        refreshData();
    </script>
</body>
</html>
"""


def build_ui_data() -> dict[str, Any]:
    apps_path = Path(os.getenv("WATCHTOWER_APPS_FILE", "./config/apps.json"))
    inventory_path = Path(os.getenv("WATCHTOWER_NODES_FILE", "./config/nodes.json"))

    apps_registry = load_apps_registry(apps_path)
    nodes, _ = load_inventory(inventory_path)

    history_list = list(DEPLOY_HISTORY)
    recent_rows = history_list[:12]

    by_app: dict[str, dict[str, Any]] = {}
    for row in history_list:
        app_key = row["app"]
        if app_key not in by_app:
            by_app[app_key] = row

    apps: list[dict[str, Any]] = []
    for name, app_cfg in sorted(apps_registry.items()):
        last = by_app.get(name)
        apps.append(
            {
                "name": name,
                "branch": app_cfg.get("branch", "main"),
                "repo_dir": app_cfg.get("repo_dir", ""),
                "last_status": last["status"] if last else "unknown",
                "last_deployed_at": last["timestamp"] if last else None,
            }
        )

    now = datetime.now(timezone.utc)
    deploys_24h = 0
    for row in history_list:
        ts = datetime.fromisoformat(row["timestamp"])
        if (now - ts).total_seconds() <= 86400:
            deploys_24h += 1

    return {
        "apps": apps,
        "recent_deployments": recent_rows,
        "usage": {
            "total_apps": len(apps),
            "total_nodes": len(nodes),
            "deployments_24h": deploys_24h,
        },
    }


def validate_token(x_watchtower_token: str | None) -> None:
    required_token = os.getenv("WATCHTOWER_TRIGGER_TOKEN")
    if required_token and not hmac.compare_digest(x_watchtower_token or "", required_token):
        raise HTTPException(status_code=401, detail="Invalid deployment token")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard() -> str:
    return DASHBOARD_HTML


@app.get("/ui/data")
def ui_data(
    x_watchtower_token: str | None = Header(default=None),
) -> dict[str, Any]:
    validate_token(x_watchtower_token)
    try:
        return build_ui_data()
    except Exception as exc:
        logger.exception("Failed to build UI data")
        raise HTTPException(status_code=500, detail="Internal server error") from exc


@app.post("/deploy")
def trigger_deploy(
    payload: DeployRequest,
    x_watchtower_token: str | None = Header(default=None),
) -> dict[str, Any]:
    validate_token(x_watchtower_token)

    source_path = (
        Path(payload.source_path).resolve() if payload.source_path else None
    )
    try:
        result = deploy(payload.branch, source_path)
        append_history(
            deployment_type="generic",
            app_name="generic",
            branch=payload.branch,
            status=result.get("status", "unknown"),
            message="Generic deployment requested",
        )
        return result
    except Exception as exc:
        append_history(
            deployment_type="generic",
            app_name="generic",
            branch=payload.branch,
            status="failed",
            message=str(exc),
        )
        logger.exception("Deployment failed")
        raise HTTPException(status_code=500, detail="Internal server error") from exc


@app.get("/apps")
def list_apps(
    x_watchtower_token: str | None = Header(default=None),
) -> dict[str, Any]:
    validate_token(x_watchtower_token)

    try:
        apps_path = Path(os.getenv("WATCHTOWER_APPS_FILE", "./config/apps.json"))
        registry = load_apps_registry(apps_path)
        return {
            "apps_file": str(apps_path),
            "apps": sorted(registry.keys()),
        }
    except Exception as exc:
        logger.exception("Failed to list apps")
        raise HTTPException(status_code=500, detail="Internal server error") from exc


@app.post("/apps/{app_name}/deploy")
def trigger_app_deploy(
    app_name: str,
    payload: AppDeployRequest,
    x_watchtower_token: str | None = Header(default=None),
) -> dict[str, Any]:
    validate_token(x_watchtower_token)

    try:
        result = deploy_registered_app(app_name, payload.branch)
        append_history(
            deployment_type="app",
            app_name=app_name,
            branch=result.get("branch", payload.branch or "main"),
            status=result.get("status", "unknown"),
            message="App deployment requested",
        )
        return result
    except Exception as exc:
        append_history(
            deployment_type="app",
            app_name=app_name,
            branch=payload.branch or "main",
            status="failed",
            message=str(exc),
        )
        logger.exception("App deployment failed")
        raise HTTPException(status_code=500, detail="Internal server error") from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Watchtower deployment orchestrator"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve_parser = subparsers.add_parser("serve", help="Run FastAPI listener")
    serve_parser.add_argument(
        "--host", default=os.getenv("WATCHTOWER_HOST", "0.0.0.0")
    )
    serve_parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("WATCHTOWER_PORT", "8000")),
    )

    deploy_parser = subparsers.add_parser(
        "deploy-now", help="Run deployment immediately"
    )
    deploy_parser.add_argument(
        "--branch", default=os.getenv("WATCHTOWER_DEFAULT_BRANCH", "main")
    )
    deploy_parser.add_argument("--source-path", default=None)

    deploy_app_parser = subparsers.add_parser(
        "deploy-app", help="Deploy a named app from apps.json"
    )
    deploy_app_parser.add_argument("--app", required=True)
    deploy_app_parser.add_argument("--branch", default=None)

    # Recovery for the install-owner-mode lockout: if the operator's
    # GitHub identity changed (e.g. token rotation gave them a different
    # internal user_id) and they're now seeing "installation owned by X,
    # ask owner to invite", running this CLI clears the claim so the
    # next sign-in re-claims ownership cleanly. Requires shell access to
    # the host running WatchTower; that's the entire authorization
    # surface — keeps the recovery path off the public API.
    subparsers.add_parser(
        "reset-installation-owner",
        help=(
            "Clear the InstallationClaim row so the next sign-in becomes "
            "the new installation owner. Requires shell access to the "
            "WatchTower host."
        ),
    )

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "deploy-now":
        source_path = (
            Path(args.source_path).resolve() if args.source_path else None
        )
        result = deploy(branch=args.branch, source_path=source_path)
        print(json.dumps(result, indent=2))
        return

    if args.command == "deploy-app":
        result = deploy_registered_app(app_name=args.app, branch=args.branch)
        print(json.dumps(result, indent=2))
        return

    if args.command == "reset-installation-owner":
        # Touch the DB directly — avoids spinning up FastAPI / Alembic
        # for a one-off operation. Idempotent: deleting zero rows is a
        # success, since "no claim exists" is the desired end state.
        from watchtower.database import SessionLocal, InstallationClaim
        session = SessionLocal()
        try:
            count = session.query(InstallationClaim).delete(synchronize_session=False)
            session.commit()
        finally:
            session.close()
        if count == 0:
            print("No installation claim was present. The next sign-in will become the owner.")
        else:
            print(f"Cleared {count} installation claim(s). The next sign-in will become the new owner.")
        return

    if args.command == "serve":
        import uvicorn

        uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
