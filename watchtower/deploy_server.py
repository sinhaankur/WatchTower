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
import json
import logging
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fabric import Connection
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(
    level=os.getenv("WATCHTOWER_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("watchtower")


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
    inventory_path = Path(os.getenv("WATCHTOWER_NODES_FILE", "./nodes.json"))

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
    apps_path = Path(os.getenv("WATCHTOWER_APPS_FILE", "./apps.json"))
    registry = load_apps_registry(apps_path)
    app_config = registry.get(app_name)
    if app_config is None:
        raise ValueError(f"Unknown app '{app_name}' in {apps_path}")

    app_repo_dir = Path(app_config["repo_dir"])
    app_inventory_path = Path(app_config.get("nodes_file", "./nodes.json"))
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


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/deploy")
def trigger_deploy(
    payload: DeployRequest,
    x_watchtower_token: str | None = Header(default=None),
) -> dict[str, Any]:
    required_token = os.getenv("WATCHTOWER_TRIGGER_TOKEN")
    if required_token and x_watchtower_token != required_token:
        raise HTTPException(status_code=401, detail="Invalid deployment token")

    source_path = (
        Path(payload.source_path).resolve() if payload.source_path else None
    )
    try:
        return deploy(payload.branch, source_path)
    except Exception as exc:
        logger.exception("Deployment failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/apps")
def list_apps(
    x_watchtower_token: str | None = Header(default=None),
) -> dict[str, Any]:
    required_token = os.getenv("WATCHTOWER_TRIGGER_TOKEN")
    if required_token and x_watchtower_token != required_token:
        raise HTTPException(status_code=401, detail="Invalid deployment token")

    try:
        apps_path = Path(os.getenv("WATCHTOWER_APPS_FILE", "./apps.json"))
        registry = load_apps_registry(apps_path)
        return {
            "apps_file": str(apps_path),
            "apps": sorted(registry.keys()),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/apps/{app_name}/deploy")
def trigger_app_deploy(
    app_name: str,
    payload: AppDeployRequest,
    x_watchtower_token: str | None = Header(default=None),
) -> dict[str, Any]:
    required_token = os.getenv("WATCHTOWER_TRIGGER_TOKEN")
    if required_token and x_watchtower_token != required_token:
        raise HTTPException(status_code=401, detail="Invalid deployment token")

    try:
        return deploy_registered_app(app_name, payload.branch)
    except Exception as exc:
        logger.exception("App deployment failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


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

    if args.command == "serve":
        import uvicorn

        uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
